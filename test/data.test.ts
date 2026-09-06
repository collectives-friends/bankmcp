import { test } from "node:test";
import assert from "node:assert/strict";
import { simplifyTransaction, simplifyBalances } from "../src/data.ts";

test("debits are negative and take the creditor as counterparty", () => {
  const t = simplifyTransaction({
    entry_reference: "abc",
    transaction_amount: { amount: "123.45", currency: "DKK" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: "2026-09-01",
    creditor: { name: "Netto" },
    remittance_information: ["Card 1234 Netto Copenhagen"],
  });
  assert.equal(t.amount, -123.45);
  assert.equal(t.counterparty, "Netto");
  assert.equal(t.description, "Card 1234 Netto Copenhagen");
  assert.equal(t.id, "abc");
});

test("credits are positive and take the debtor", () => {
  const t = simplifyTransaction({
    transaction_id: "x",
    transaction_amount: { amount: "10000", currency: "DKK" },
    credit_debit_indicator: "CRDT",
    status: "BOOK",
    booking_date: "2026-09-01",
    debtor: { name: "Acme Ltd" },
  });
  assert.equal(t.amount, 10000);
  assert.equal(t.counterparty, "Acme Ltd");
  assert.equal(t.description, undefined);
});

test("booked prefers CLBD, then ITBD; available is XPCD", () => {
  const b = simplifyBalances([
    { balance_type: "XPCD", balance_amount: { amount: "1500.00", currency: "DKK" } },
    { balance_type: "ITBD", balance_amount: { amount: "-500000.00", currency: "DKK" } },
  ]);
  assert.equal(b.booked, -500000);
  assert.equal(b.available, 1500);
  const c = simplifyBalances([
    { balance_type: "ITBD", balance_amount: { amount: "1", currency: "EUR" } },
    { balance_type: "CLBD", balance_amount: { amount: "2", currency: "EUR" } },
  ]);
  assert.equal(c.booked, 2);
  assert.equal(c.available, undefined);
});
