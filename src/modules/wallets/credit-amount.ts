import { Prisma } from '@prisma/client';

export const CREDIT_DECIMAL_PLACES = 6;

export type CreditAmountInput = Prisma.Decimal.Value | bigint;

export function creditDecimal(value: CreditAmountInput) {
  return new Prisma.Decimal(value.toString()).toDecimalPlaces(CREDIT_DECIMAL_PLACES);
}

export function serializeCredit(value: CreditAmountInput) {
  return creditDecimal(value).toFixed(CREDIT_DECIMAL_PLACES);
}
