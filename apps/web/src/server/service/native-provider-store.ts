import { Prisma } from "@prisma/client";
import { db } from "../db";
import { getRedis } from "../redis";
import { ProviderStore } from "./native-provider-admission";

function transactionStore(tx: Prisma.TransactionClient): ProviderStore {
  return {
    get: async (key) =>
      (await tx.appSetting.findUnique({ where: { key } }))?.value ?? null,
    create: async (key, value) => {
      await tx.appSetting.create({ data: { key, value } });
    },
    put: async (key, value) => {
      await tx.appSetting.update({ where: { key }, data: { value } });
    },
    locked: async (_key, action) => action(transactionStore(tx)),
  };
}
export function createNativeProviderStore(database: typeof db): ProviderStore {
  return {
    get: async (key) =>
      (await database.appSetting.findUnique({ where: { key } }))?.value ?? null,
    create: async (key, value) => {
      await database.appSetting.create({ data: { key, value } });
    },
    put: async (key, value) => {
      await database.appSetting.update({ where: { key }, data: { value } });
    },
    locked: (key, action) =>
      database.$transaction(async (tx) => {
        // Only the new account+region ledger participates; no legacy worker lock.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`;
        return action(transactionStore(tx));
      }),
  };
}
export const nativeProviderStore = createNativeProviderStore(db);
export const nativeProviderRedis = {
  get: (key: string) => getRedis().get(key),
  create: async (key: string, value: string) =>
    (await getRedis().set(key, value, "NX")) === "OK",
  compareSwap: async (key: string, old: string, value: string) =>
    Number(
      await getRedis().eval(
        "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;redis.call('SET',KEYS[1],ARGV[2]);return 1",
        1,
        key,
        old,
        value,
      ),
    ) === 1,
};
