import { UTXOPoolManager } from '../utxo-pool';
import { generateKeyPair, KeyPair } from '../utils/crypto';
import * as BinaryEncoder from '../utils/binary-encoding';
import { TransactionBuilder } from '../transaction-builder';
import { TransactionValidator } from '../transaction-validator';
import { Transaction, UTXO } from '../types';
import { VALIDATION_ERRORS } from '../errors';

describe('UTXO System Tests', () => {
  let utxoPool: UTXOPoolManager;
  let alice: KeyPair;
  let bob: KeyPair;
  let charlie: KeyPair;
  let validator: TransactionValidator;

  beforeEach(() => {
    utxoPool = new UTXOPoolManager();
    alice = generateKeyPair();
    bob = generateKeyPair();
    charlie = generateKeyPair();
    validator = new TransactionValidator(utxoPool);

    // Create initial UTXOs (genesis)
    utxoPool.createGenesisUTXOs({
      [alice.publicKey]: 1000,
      [bob.publicKey]: 500,
      [charlie.publicKey]: 250
    });
  });

  describe("Basic UTXO Operations (built-in functionality, don't change this)", () => {
    test('BUILT-IN: should create genesis UTXOs correctly', () => {
      expect(utxoPool.getBalance(alice.publicKey)).toBe(1000);
      expect(utxoPool.getBalance(bob.publicKey)).toBe(500);
      expect(utxoPool.getBalance(charlie.publicKey)).toBe(250);
    });

    test('BUILT-IN: should find UTXOs for owner', () => {
      const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
      expect(aliceUTXOs).toHaveLength(1);
      expect(aliceUTXOs[0].amount).toBe(1000);
      expect(aliceUTXOs[0].recipient).toBe(alice.publicKey);
    });
  });

  describe('ASSIGNMENT', () => {
    describe('Transaction Validation', () => {
      test('REQUIRED: should validate a simple transaction correctly', () => {
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const transaction = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: alice.privateKey }],
          [
            { amount: 300, recipient: bob.publicKey },
            { amount: 700, recipient: alice.publicKey }
          ]
        );

        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      test('REQUIRED: should reject transaction with invalid signature', () => {
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const transaction = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: bob.privateKey }], // Wrong key!
          [
            { amount: 300, recipient: bob.publicKey },
            { amount: 700, recipient: alice.publicKey }
          ]
        );

        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === VALIDATION_ERRORS.INVALID_SIGNATURE)).toBe(true);
      });

      test('REQUIRED: should reject transaction with unbalanced amounts', () => {
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const transaction = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: alice.privateKey }],
          [
            { amount: 300, recipient: bob.publicKey },
            { amount: 800, recipient: alice.publicKey } // Total: 1100 > 1000 input
          ]
        );

        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === VALIDATION_ERRORS.AMOUNT_MISMATCH)).toBe(true);
      });

      test('REQUIRED: should reject transaction using non-existent UTXO', () => {
        const fakeUTXO: UTXO = {
          amount: 500,
          recipient: alice.publicKey,
          id: {
            txId: 'non-existent',
            outputIndex: 0
          }
        };

        const transaction = TransactionBuilder.createTransaction(
          [{ utxo: fakeUTXO, privateKey: alice.privateKey }],
          [{ amount: 500, recipient: bob.publicKey }]
        );

        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === VALIDATION_ERRORS.UTXO_NOT_FOUND)).toBe(true);
      });

      test('REQUIRED: should reject double spending in same transaction', () => {
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const utxo = aliceUTXOs[0];

        const transaction = TransactionBuilder.createTransaction(
          [
            { utxo, privateKey: alice.privateKey },
            { utxo, privateKey: alice.privateKey } // Same UTXO used twice
          ],
          [{ amount: 2000, recipient: bob.publicKey }]
        );

        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === VALIDATION_ERRORS.DOUBLE_SPENDING)).toBe(true);
      });

      test('REQUIRED: should validate multi-input transaction', () => {
        // Create additional UTXO for Alice to have 2 UTXOs
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const firstTx = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: alice.privateKey }],
          [
            { amount: 600, recipient: alice.publicKey },
            { amount: 400, recipient: alice.publicKey }
          ]
        );
        utxoPool.processTransaction(firstTx);

        // Now Alice has 2 UTXOs (600 + 400) and Bob has 1 UTXO (500)
        const aliceNewUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const bobUTXOs = utxoPool.getUTXOsForOwner(bob.publicKey);

        const transaction = TransactionBuilder.createTransaction(
          [
            { utxo: aliceNewUTXOs[0], privateKey: alice.privateKey }, // 600
            { utxo: aliceNewUTXOs[1], privateKey: alice.privateKey }, // 400
            { utxo: bobUTXOs[0], privateKey: bob.privateKey } // 500
          ],
          [
            { amount: 1000, recipient: charlie.publicKey },
            { amount: 500, recipient: alice.publicKey }
          ]
        );

        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe('Transaction Processing & Integration', () => {
      test('REQUIRED: should update UTXO pool after valid transaction', () => {
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const transaction = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: alice.privateKey }],
          [
            { amount: 300, recipient: bob.publicKey },
            { amount: 700, recipient: alice.publicKey }
          ]
        );

        // Validate and process transaction
        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(true);

        utxoPool.processTransaction(transaction);

        // Check balances after transaction
        expect(utxoPool.getBalance(alice.publicKey)).toBe(700);
        expect(utxoPool.getBalance(bob.publicKey)).toBe(800); // 500 + 300
        expect(utxoPool.getBalance(charlie.publicKey)).toBe(250);
      });

      test('REQUIRED: complete transaction flow', () => {
        // Step 1: Validate transaction
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const transaction = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: alice.privateKey }],
          [
            { amount: 400, recipient: bob.publicKey },
            { amount: 600, recipient: alice.publicKey }
          ]
        );

        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(true);

        // Step 2: Process transaction
        utxoPool.processTransaction(transaction);

        // Step 3: Verify final state
        expect(utxoPool.getBalance(alice.publicKey)).toBe(600);
        expect(utxoPool.getBalance(bob.publicKey)).toBe(900); // 500 + 400
      });

      test('REQUIRED: sequential transactions', () => {
        // First transaction
        let aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const tx1 = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: alice.privateKey }],
          [
            { amount: 200, recipient: bob.publicKey },
            { amount: 800, recipient: alice.publicKey }
          ]
        );

        expect(validator.validateTransaction(tx1).valid).toBe(true);
        utxoPool.processTransaction(tx1);

        // Second transaction using output from first
        aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const aliceNewUTXO = aliceUTXOs.find(u => u.id.txId === tx1.id);
        expect(aliceNewUTXO).toBeDefined();

        const tx2 = TransactionBuilder.createTransaction(
          [{ utxo: aliceNewUTXO!, privateKey: alice.privateKey }],
          [{ amount: 800, recipient: charlie.publicKey }]
        );

        expect(validator.validateTransaction(tx2).valid).toBe(true);
        utxoPool.processTransaction(tx2);

        // Final balances
        expect(utxoPool.getBalance(alice.publicKey)).toBe(0);
        expect(utxoPool.getBalance(bob.publicKey)).toBe(700); // 500 + 200
        expect(utxoPool.getBalance(charlie.publicKey)).toBe(1050); // 250 + 800
      });
    });

    describe('Edge Cases', () => {
      test('REQUIRED: should reject zero-amount outputs', () => {
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const transaction = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: alice.privateKey }],
          [
            { amount: 0, recipient: bob.publicKey },
            { amount: 1000, recipient: alice.publicKey }
          ]
        );

        const result = validator.validateTransaction(transaction);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === VALIDATION_ERRORS.NEGATIVE_AMOUNT)).toBe(true);
      });
    });

    // 💡 BONUS CHALLENGE: Binary Encoding
    // Uncomment the describe.skip line below (remove .skip) when you're ready to implement binary encoding!
    describe('Binary Encoding', () => {
      test('BONUS: should encode and decode transactions correctly', () => {
        const aliceUTXOs = utxoPool.getUTXOsForOwner(alice.publicKey);
        const transaction = TransactionBuilder.createTransaction(
          [{ utxo: aliceUTXOs[0], privateKey: alice.privateKey }],
          [
            { amount: 300, recipient: bob.publicKey },
            { amount: 700, recipient: alice.publicKey }
          ]
        );

        const encoded = BinaryEncoder.encodeTransaction(transaction);
        const decoded = BinaryEncoder.decodeTransaction(encoded);

        expect(decoded).toEqual(transaction);
      });
    });
  });
});
