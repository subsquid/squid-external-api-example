import * as ss58 from "@subsquid/ss58";
import {
  BatchContext,
  BatchProcessorItem,
  EventHandlerContext,
  SubstrateBatchProcessor,
  toHex,
} from "@subsquid/substrate-processor";
import { lookupArchive } from "@subsquid/archive-registry";
import { Account, HistoricalBalance, Transfer } from "./model";
import { BalancesTransferEvent } from "./types/events";
import axios from "axios";
import moment from "moment";
import { Store, TypeormDatabase } from "@subsquid/typeorm-store";
import { In } from "typeorm";
import { debounce } from "ts-debounce";

const priceCache = new Map();
const blockchain = "moonbeam";
const processor = new SubstrateBatchProcessor()
  .setBatchSize(100)
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
        if (e.asV900) {
          let [from, to, amount] = e.asV900;
          rec = { from, to, amount };
        } else {
          rec = e.asV1201;
        }
        transfers.push({
          id: item.event.id,
          from: toHex(rec.from),
          to: toHex(rec.to),
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

  console.log(`cache miss on date ${date}`);

  async function fillPriceCache() {
    console.log("filling up price cache...");
    const ohlc = await axios
      .get(
        // see https://docs.cryptowat.ch/rest-api/markets/ohlc
        // plus, reverse engineering on their v2, on https://cryptowat.ch/charts/KRAKEN:BTC-USD
        `https://api.cryptowat.ch/v2/markets/2909869/ohlc/1d`
      )
      .then((res) => {
        return res.data.result["1d"];
      })
      .catch((error) => {
        console.error(
          `Failed API for with status code: ${error.response.status} ${error.message}`
        );
        return Promise.reject(error);
      });

    for (const day of ohlc) {
      // the API returns past 6000 values, only update the ones we don't have in cache
      if (!priceCache.has(date)) {
        priceCache.set(moment(new Date(day.ct)).format("DD-MM-yyyy"), day.c);
      }
    }

    return true;
  }

  await fillPriceCache();

  // the fallback to 0 covers cases where transfers appear on chain, 
  // but markets still didn't have a quote of the token
  if (!priceCache.has(date)) priceCache.set(date, 0);

  return priceCache.get(date);
}
