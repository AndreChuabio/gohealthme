import { isClaimed, markClaimed } from "@/lib/server/claims";

export interface PayoutTreasury {
  deposit(args: { token: string; amount: string }): Promise<unknown>;
  transfer(args: { token: string; amount: string; recipientAddress: string }): Promise<unknown>;
}
export interface PayoutResult { status: "paid" | "already-claimed"; }

/**
 * Deliver a reward privately. Marks claimed BEFORE moving funds (idempotent retry).
 * Treasury deposits into its own shielded balance, then privately transfers to the
 * participant — the deposit->transfer pair is what breaks the goal<->recipient link.
 */
export async function runPrivatePayout(args: {
  goalId: string;
  recipientUnlinkAddress: string;
  amountBaseUnits: string;
  token: string;
  treasury: PayoutTreasury;
}): Promise<PayoutResult> {
  if (await isClaimed(args.goalId)) return { status: "already-claimed" };
  await markClaimed(args.goalId);
  await args.treasury.deposit({ token: args.token, amount: args.amountBaseUnits });
  await args.treasury.transfer({
    token: args.token,
    amount: args.amountBaseUnits,
    recipientAddress: args.recipientUnlinkAddress,
  });
  return { status: "paid" };
}
