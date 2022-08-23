import * as ss58 from "@subsquid/ss58";
import {
  BatchContext,
  BatchProcessorItem,
  EventHandlerContext,
  SubstrateBatchProcessor,
} from "@subsquid/substrate-processor";
import { lookupArchive } from "@subsquid/archive-registry";
import { Account, HistoricalBalance, Transfer } from "./model";
import { BalancesTransferEvent } from "./types/events";
import axios from "axios";
import moment from "moment";
import { Store, TypeormDatabase } from "@subsquid/typeorm-store";
import { In } from "typeorm";

const priceCache = new Map();
const blockchain = "kusama";
const processor = new SubstrateBatchProcessor()
  .setBatchSize(500)
  .setDataSource({
    archive: lookupArchive(`${blockchain}`, { release: "FireSquid" }),
  })
  .addEvent("Balances.Transfer", {
    data: { event: { args: true } },
  } as const);

type Item = BatchProcessorItem<typeof processor>;
type Ctx = BatchContext<Store, Item>;

processor.run(new TypeormDatabase(), async (ctx) => {
  let transfers = getTransfers(ctx);

  let accountIds = new Set<string>();
  for (let t of transfers) {
    accountIds.add(t.from);
    accountIds.add(t.to);
  }

  let accounts = await ctx.store
    .findBy(Account, { id: In([...accountIds]) })
    .then((accounts) => {
      return new Map(accounts.map((a) => [a.id, a]));
    });

  let history: HistoricalBalance[] = [];
  let transferHistory: Transfer[] = [];

  for (let t of transfers) {
    let from = getAccount(accounts, t.from);
    let to = getAccount(accounts, t.to);

    from.balance -= t.amount;
    to.balance += t.amount;

    const transferDate = new Date(Number(t.timestamp));

    history.push(
      new HistoricalBalance({
        id: t.id + "-from",
        account: from,
        balance: from.balance,
        date: transferDate,
      })
    );

    history.push(
      new HistoricalBalance({
        id: t.id + "-to",
        account: to,
        balance: to.balance,
        date: transferDate,
      })
    );
    const formattedDateString = moment(transferDate.toISOString()).format(
      "DD-MM-yyyy"
    );

    const transferPrice = await getTokenPriceByDate(formattedDateString);
    transferHistory.push(
      new Transfer({
        id: `${t.id}-transfer`,
        to: to,
        from: from,
        amount: t.amount,
        date: transferDate,
        price: transferPrice,
      })
    );
  }

  await ctx.store.save(Array.from(accounts.values()));
  await ctx.store.insert(history);
  await ctx.store.insert(transferHistory);
});

interface TransferEvent {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  timestamp: bigint;
}

function getTransfers(ctx: Ctx): TransferEvent[] {
  let transfers: TransferEvent[] = [];
  for (let block of ctx.blocks) {
    for (let item of block.items) {
      if (item.name == "Balances.Transfer") {
        let e = new BalancesTransferEvent(ctx, item.event);
        let rec: { from: Uint8Array; to: Uint8Array; amount: bigint };
        if (e.isV1020) {
          let [from, to, amount] = e.asV1020;
          rec = { from, to, amount };
        } else if (e.isV1050) {
          let [from, to, amount] = e.asV1050;
          rec = { from, to, amount };
        } else {
          rec = e.asV9130;
        }
        transfers.push({
          id: item.event.id,
          from: ss58.codec(blockchain).encode(rec.from),
          to: ss58.codec(blockchain).encode(rec.to),
          amount: rec.amount,
          timestamp: BigInt(block.header.timestamp),
        });
      }
    }
  }
  return transfers;
}

function getAccount(m: Map<string, Account>, id: string): Account {
  let acc = m.get(id);
  if (acc == null) {
    acc = new Account();
    acc.id = id;
    acc.balance = 0n;
    m.set(id, acc);
  }
  return acc;
}

async function getTokenPriceByDate(date: string): Promise<bigint> {
  if (priceCache.has(date)) return priceCache.get(date);

  priceCache.set(
    date,
    axios
      .get(
        `https://api.coingecko.com/api/v3/coins/${blockchain}/history?date=${date}&localization=false`
      )
      .then((res) => {
        // console.log(`statusCode: ${res.status}`);
        return res.data.market_data.current_price.usd;
      })
      .catch((error) => {
        console.error(error);
        // Delete cache entry if API call fails
        priceCache.delete(date);
        return Promise.reject(error);
      })
  );

  return priceCache.get(date);
}
