import { Transaction, TransactionInput } from './types';
import { UTXOPoolManager } from './utxo-pool';
import { verify } from './utils/crypto';
import {
  ValidationResult,
  ValidationError,
  VALIDATION_ERRORS,
  createValidationError
} from './errors';

export class TransactionValidator {
  constructor(private utxoPool: UTXOPoolManager) {}

  /**
   * Validate a transaction
   * @param {Transaction} transaction - The transaction to validate
   * @returns {ValidationResult} The validation result
   */
  validateTransaction(transaction: Transaction): ValidationResult {
    const errors: ValidationError[] = [];
    const usedUtxos = new Set<string>();
    let totalInput = 0;
    let totalOutput = 0;

    if (transaction.inputs.length === 0) errors.push(createValidationError(VALIDATION_ERRORS.EMPTY_INPUTS, 'Transaccion sin entradas'));

    if (transaction.outputs.length === 0) errors.push(createValidationError(VALIDATION_ERRORS.EMPTY_OUTPUTS, 'Transaccion sin salidas'));

    const transactionData = this.createTransactionDataForSigning_(transaction);

    for (const input of transaction.inputs) 
    {
      const utxo = this.utxoPool.getUTXO(input.utxoId.txId, input.utxoId.outputIndex);
      const utxoKey = `${input.utxoId.txId}:${input.utxoId.outputIndex}`;

      if (!utxo) 
      {
        errors.push(createValidationError(VALIDATION_ERRORS.UTXO_NOT_FOUND, `UTXO not found: ${utxoKey}`, {utxoId: input.utxoId}));
        continue;
      }

      if (usedUtxos.has(utxoKey)) 
      {
        errors.push(createValidationError(VALIDATION_ERRORS.DOUBLE_SPENDING, `UTXO referenced multiple times: ${utxoKey}`, {utxoId: input.utxoId}));
        continue;
      }
      usedUtxos.add(utxoKey);

      if (!verify(transactionData, input.signature, utxo.recipient)) 
      {
        errors.push(createValidationError(VALIDATION_ERRORS.INVALID_SIGNATURE, `Invalid signature for UTXO: ${utxoKey}`, {utxoId: input.utxoId}));
      }

      totalInput += utxo.amount;
    }

    for (const output of transaction.outputs) 
    {
      if (output.amount <= 0) 
      {
        errors.push(createValidationError(VALIDATION_ERRORS.NEGATIVE_AMOUNT, `Non-positive output amount: ${output.amount}`, {output}));
      }
      totalOutput += output.amount;
    }

    if (totalInput !== totalOutput) 
    {
      errors.push(createValidationError(VALIDATION_ERRORS.AMOUNT_MISMATCH, `Input and output amounts do not match: ${totalInput} != ${totalOutput}`, {totalInput, totalOutput}));
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Create a deterministic string representation of the transaction for signing
   * This excludes the signatures to prevent circular dependencies
   * @param {Transaction} transaction - The transaction to create a data for signing
   * @returns {string} The string representation of the transaction for signing
   */
  private createTransactionDataForSigning_(transaction: Transaction): string {
    const unsignedTx = {
      id: transaction.id,
      inputs: transaction.inputs.map(input => ({
        utxoId: input.utxoId,
        owner: input.owner
      })),
      outputs: transaction.outputs,
      timestamp: transaction.timestamp
    };

    return JSON.stringify(unsignedTx);
  }
}
