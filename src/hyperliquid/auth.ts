import { ethers } from 'ethers';
import { encode } from '@msgpack/msgpack';

// EIP-712 domain for L1 actions (phantom agent)
const L1_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

// Type definitions for EIP-712 signing
const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

export class HyperliquidAuth {
  private wallet: ethers.Wallet;
  private isTestnet: boolean;

  constructor(privateKey: string, isTestnet: boolean = false) {
    this.wallet = new ethers.Wallet(privateKey);
    this.isTestnet = isTestnet;
  }

  get address(): string {
    return this.wallet.address;
  }

  async signL1Action(
    action: Record<string, unknown>,
    nonce: number,
    vaultAddress: string | null = null
  ): Promise<{ r: string; s: string; v: number }> {
    // Normalize the action (remove trailing zeros from price/size)
    const normalizedAction = this.normalizeAction(action);

    // Create the action hash using msgpack encoding
    const connectionId = this.hashAction(normalizedAction, vaultAddress, nonce);

    // Create the phantom agent for EIP-712 signing
    const agent = {
      source: this.isTestnet ? 'b' : 'a', // 'a' for mainnet, 'b' for testnet
      connectionId: connectionId,
    };

    // Sign using EIP-712 typed data
    const signature = await this.wallet._signTypedData(L1_DOMAIN, AGENT_TYPES, agent);
    const { r, s, v } = ethers.utils.splitSignature(signature);

    return { r, s, v: v! };
  }

  private normalizeAction(action: Record<string, unknown>): Record<string, unknown> {
    // Deep clone the action
    const normalized = JSON.parse(JSON.stringify(action));

    // Normalize orders if present
    if (normalized.orders && Array.isArray(normalized.orders)) {
      normalized.orders = normalized.orders.map((order: Record<string, unknown>) => ({
        ...order,
        p: this.removeTrailingZeros(order.p as string),
        s: this.removeTrailingZeros(order.s as string),
      }));
    }

    return normalized;
  }

  private removeTrailingZeros(value: string): string {
    if (!value || typeof value !== 'string') return value;
    // Remove trailing zeros after decimal point
    if (value.includes('.')) {
      let result = value.replace(/\.?0+$/, '');
      // Ensure at least one digit after decimal if there was a decimal
      if (result.includes('.') === false && value.includes('.')) {
        result = value.replace(/0+$/, '');
        if (result.endsWith('.')) {
          result = result.slice(0, -1);
        }
      }
      return result;
    }
    return value;
  }

  private hashAction(
    action: Record<string, unknown>,
    vaultAddress: string | null,
    nonce: number
  ): string {
    // Encode action using msgpack
    const msgPackAction = encode(action);

    // Convert nonce to 8-byte big-endian buffer
    const nonceBytes = new Uint8Array(8);
    const view = new DataView(nonceBytes.buffer);
    view.setBigUint64(0, BigInt(nonce), false); // false = big-endian

    // Concatenate msgpack action + nonce + optional vault address
    let data: Uint8Array;
    if (vaultAddress) {
      const vaultBytes = ethers.utils.arrayify(vaultAddress);
      data = new Uint8Array([...msgPackAction, ...nonceBytes, ...vaultBytes]);
    } else {
      data = new Uint8Array([...msgPackAction, ...nonceBytes]);
    }

    // Return keccak256 hash as bytes32
    return ethers.utils.keccak256(data);
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string> {
    const signature = await this.wallet._signTypedData(domain, types, value);
    return signature;
  }
}
