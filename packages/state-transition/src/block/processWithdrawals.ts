import {ssz, capella} from "@lodestar/types";
import {MAX_EFFECTIVE_BALANCE, ETH1_ADDRESS_WITHDRAWAL_PREFIX, MAX_WITHDRAWALS_PER_PAYLOAD} from "@lodestar/params";

import {CachedBeaconStateCapella} from "../types.js";
import {decreaseBalance} from "../util/index.js";

export function getExpectedWithdrawals(state: CachedBeaconStateCapella): capella.Withdrawal[] {
  const currentEpoch = state.epochCtx.epoch + 1;
  let withdrawalIndex = state.nextWithdrawalIndex;
  let validatorIndex = state.nextWithdrawalValidatorIndex;
  const {validators, balances} = state;

  const withdrawals: capella.Withdrawal[] = [];
  // Just run a bounded loop max iterating over all withdrawals
  // however breaks out once we have MAX_WITHDRAWALS_PER_PAYLOAD
  for (let i = 0; i < validators.length; i++) {
    const validator = validators.getReadonly(validatorIndex);
    const balance = balances.get(validatorIndex);
    const {effectiveBalance, withdrawalCredentials, withdrawableEpoch} = validator;

    if (
      ((balance > 0 && withdrawableEpoch <= currentEpoch) ||
        (effectiveBalance === MAX_EFFECTIVE_BALANCE && balance > MAX_EFFECTIVE_BALANCE)) &&
      // WITHDRAWAL_PREFIX_BYTES is just 1
      withdrawalCredentials[0] === ETH1_ADDRESS_WITHDRAWAL_PREFIX[0]
    ) {
      const amount = withdrawableEpoch <= currentEpoch ? balance : balance - MAX_EFFECTIVE_BALANCE;
      const address = withdrawalCredentials.slice(12);
      withdrawals.push({
        index: withdrawalIndex,
        validatorIndex,
        address,
        amount: BigInt(amount),
      });
      withdrawalIndex++;
    }

    // Break if we have enough to pack the block
    if (withdrawals.length >= MAX_WITHDRAWALS_PER_PAYLOAD) {
      break;
    }
    // Get next validator in turn
    validatorIndex = (validatorIndex + 1) % validators.length;
  }
  return withdrawals;
}

export function processWithdrawals(
  state: CachedBeaconStateCapella,
  payload: capella.FullOrBlindedExecutionPayload
): void {
  const expectedWithdrawals = getExpectedWithdrawals(state);
  const numWithdrawals = expectedWithdrawals.length;

  if (expectedWithdrawals.length !== payload.withdrawals.length) {
    throw Error(`Invalid withdrawals length expected=${numWithdrawals} actual=${payload.withdrawals.length}`);
  }
  for (let i = 0; i < numWithdrawals; i++) {
    const withdrawal = expectedWithdrawals[i];
    if (!ssz.capella.Withdrawal.equals(withdrawal, payload.withdrawals[i])) {
      throw Error(`Withdrawal mismatch at index=${i}`);
    }
    decreaseBalance(state, withdrawal.validatorIndex, Number(withdrawal.amount));
  }
  if (expectedWithdrawals.length > 0) {
    const latestWithdrawal = expectedWithdrawals[expectedWithdrawals.length - 1];
    state.nextWithdrawalIndex = latestWithdrawal.index + 1;
    state.nextWithdrawalValidatorIndex = (latestWithdrawal.validatorIndex + 1) % state.validators.length;
  }
}
