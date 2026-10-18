import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, inventory, inventorylog, users } from "../db/schema";
import { logger } from "../logger";
import { ApplyInventoryTransactionInTx, InventoryErrorOf } from "./inventory";
import type { Tx } from "./savehistory";

// The owner's admin panel (UndauntedPanel): a player's currencies, and giving or taking them back.
// Admin key, loopback only (HasUndauntedAdminApiKey refuses proxied requests). Grants go through the
// inventory core as caller "admin": same ledger, so the same grant id never pays twice, and the same
// inventorylog rows. A removal never takes a balance below 0.

// The currencies the panel shows, by the stack that holds them (Platinum: the stack the store charges)
export const WALLET_CURRENCIES: { Key: string, CatalogId: string, Label: string }[] = [
    { Key: "platinum", CatalogId: "CURRENCY_PLATINUM_UNIV", Label: "Platine" },
    { Key: "rams", CatalogId: "CURRENCY_NOTES", Label: "Béliers" },
    { Key: "aetherdust", CatalogId: "CURRENCY_CELLDUST", Label: "Poussière d'aether" },
    { Key: "marks_steel", CatalogId: "CURRENCY_MARKS_STEEL", Label: "Marques d'acier" },
    { Key: "marks_gilded", CatalogId: "CURRENCY_MARKS_GILDED", Label: "Marques dorées" },
    { Key: "prestige", CatalogId: "CURRENCY_PRESTIGE", Label: "Prestige" },
    { Key: "dark_harvest", CatalogId: "CURRENCY_EVENT_DARKHARVEST", Label: "Dark Harvest" }
];

const MAX_GRANT = 1_000_000;
const GRANT_ID = /^[A-Za-z0-9_.:-]{8,80}$/;

export class WalletError extends Error {
    constructor(public Status: number, public Code: string){
        super(Code);
    }
}

function CharacterOf(AccountId: string){
    return GetDb().select({ characterId: characters.characterId, name: characters.name }).from(characters)
        .where(eq(characters.userId, AccountId)).all();
}

function StacksOf(CharacterId: string): any[] {
    const Row = GetDb().select({ stackedItems: inventory.stackedItems }).from(inventory).where(eq(inventory.characterId, CharacterId)).get();
    try {
        const Stacks = JSON.parse(Row?.stackedItems ?? "[]");
        return Array.isArray(Stacks) ? Stacks : [];
    }
    catch {
        return [];
    }
}

function StacksInTx(tx: Tx, CharacterId: string): any[] {
    const Row = tx.select({ stackedItems: inventory.stackedItems }).from(inventory).where(eq(inventory.characterId, CharacterId)).get();
    try {
        const Stacks = JSON.parse(Row?.stackedItems ?? "[]");
        return Array.isArray(Stacks) ? Stacks : [];
    }
    catch {
        return [];
    }
}

function Quantity(Stacks: any[], CatalogId: string){
    const Stack = Stacks.find((Item) => Item?.catalogId === CatalogId);
    const Value = Number(Stack?.quantity);
    return Number.isSafeInteger(Value) && Value > 0 ? Value : 0;
}

// Every character of the account with its balances (a 1.14.7 account has one)
export function GetPlayerWallet(AccountId: unknown){
    if(typeof AccountId !== "string" || AccountId.length === 0) throw new WalletError(400, "bad_account");
    const User = GetDb().select({ userId: users.userId, name: users.name }).from(users).where(eq(users.userId, AccountId)).get();
    if(User === undefined) throw new WalletError(404, "account_not_found");

    return {
        accountId: User.userId,
        username: User.name,
        currencies: WALLET_CURRENCIES.map(({ Key, Label }) => ({ key: Key, label: Label })),
        characters: CharacterOf(User.userId).map((Character) => {
            const Stacks = StacksOf(Character.characterId);
            return {
                characterId: Character.characterId,
                name: Character.name,
                balances: Object.fromEntries(WALLET_CURRENCIES.map(({ Key, CatalogId }) => [Key, Quantity(Stacks, CatalogId)]))
            };
        })
    };
}

// Gives (amount > 0) or takes back (amount < 0) one currency. grantId: chosen by the caller, the same id
// answers the stored result (replayed) and pays nothing more.
export function GrantCurrency(Body: any, Actor: string){
    const AccountId = Body?.accountId;
    const Currency = WALLET_CURRENCIES.find(({ Key }) => Key === Body?.currency);
    const Amount = Body?.amount;
    const GrantId = Body?.grantId;
    const Reason = typeof Body?.reason === "string" ? Body.reason.trim().slice(0, 200) : "";

    if(typeof AccountId !== "string" || AccountId.length === 0) throw new WalletError(400, "bad_account");
    if(Currency === undefined) throw new WalletError(400, "bad_currency");
    if(!Number.isSafeInteger(Amount) || Amount === 0 || Math.abs(Amount) > MAX_GRANT) throw new WalletError(400, "bad_amount");
    if(typeof GrantId !== "string" || !GRANT_ID.test(GrantId)) throw new WalletError(400, "bad_grant_id");

    const Characters = CharacterOf(AccountId);
    if(GetDb().select({ userId: users.userId }).from(users).where(eq(users.userId, AccountId)).get() === undefined) throw new WalletError(404, "account_not_found");
    if(Characters.length === 0) throw new WalletError(409, "no_character");
    const CharacterId = typeof Body?.characterId === "string" ? Body.characterId : Characters[0].characterId;
    if(!Characters.some((Character) => Character.characterId === CharacterId)) throw new WalletError(404, "character_not_found");

    try {
        const Result = GetDb().transaction((tx) => {
            // The core's ledger tells requests apart by their content: a grant id already used for another
            // character, currency or amount would pay again, so it is refused here
            const Used = tx.select({ characterId: inventorylog.characterId, catalogId: inventorylog.catalogId, quantityChange: inventorylog.quantityChange })
                .from(inventorylog).where(eq(inventorylog.transactionId, `admin-${GrantId}`)).all();
            if(Used.some((Row) => Row.characterId !== CharacterId || Row.catalogId !== Currency.CatalogId || Row.quantityChange !== Amount)){
                throw new WalletError(409, "grant_id_reused");
            }

            const Stacks = StacksInTx(tx, CharacterId);
            const Before = Quantity(Array.isArray(Stacks) ? Stacks : [], Currency.CatalogId);
            const Item = [{ catalogId: Currency.CatalogId, quantity: Math.abs(Amount) }];

            const Applied = ApplyInventoryTransactionInTx(tx, {
                UserId: AccountId,
                CharacterId,
                TransactionId: `admin-${GrantId}`,
                StackedItemsToAdd: Amount > 0 ? Item : [],
                StackedItemsToRemove: Amount < 0 ? Item : []
            }, { Caller: "admin", Source: `panel:${Actor}${Reason ? `:${Reason}` : ""}` });

            const After = Quantity(StacksInTx(tx, CharacterId), Currency.CatalogId);
            // The core clamps an overspend to 0: a removal larger than the balance is refused instead
            if(!Applied.replayed && Amount < 0 && Before + Amount < 0) throw new WalletError(409, "insufficient_balance");

            return { replayed: Applied.replayed, balance: After };
        });

        logger.info(`wallet: ${Result.replayed ? "replayed" : "granted"} ${Amount} ${Currency.Key} to ${AccountId} by=${Actor} grant=${GrantId}${Reason ? ` reason=${JSON.stringify(Reason)}` : ""} -> ${Result.balance}`);
        return { accountId: AccountId, characterId: CharacterId, currency: Currency.Key, amount: Amount, balance: Result.balance, replayed: Result.replayed };
    }
    catch(error){
        if(error instanceof WalletError) throw error;
        const Code = InventoryErrorOf(error);
        if(Code === "conflict") throw new WalletError(409, "grant_id_reused");
        if(Code !== undefined) throw new WalletError(409, Code);
        throw error;
    }
}
