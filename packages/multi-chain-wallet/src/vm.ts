
import { Balance, ChainWalletConfig, TokenInfo, vmTypes } from "./types";
import * as bip39 from "@scure/bip39";
import CryptoJS from "crypto-js";
// Abstract Base Classes
export abstract class VM<AddressType, PrivateKeyType, ConnectionType> {
    protected seed: string;
    type: vmTypes

    constructor(seed: string, vm: vmTypes) {
        this.type = vm;
        this.seed = seed
    }
    static mnemonicToSeed = (mnemonic: string) => {
        return Buffer.from(bip39.mnemonicToSeedSync(mnemonic)).toString("hex");
    }

    static generateSalt(): string {
        return CryptoJS.lib.WordArray.random(16).toString(); // 128-bit salt
    }
    static deriveKey(
        password: string,
        salt: string,
        iterations = 10000,
        keySize = 256 / 32
    ) {
        return CryptoJS.PBKDF2(password, CryptoJS.enc.Hex.parse(salt), {
            keySize: keySize,
            iterations: iterations,
        }).toString();
    }
    static encryptSeedPhrase(seedPhrase: string, password: string) {
        const salt = this.generateSalt(); // Generate a unique salt for this encryption
        const key = this.deriveKey(password, salt); // Derive a key using PBKDF2

        // Encrypt the seed phrase with AES using the derived key
        const encrypted = CryptoJS.AES.encrypt(seedPhrase, key).toString();

        // Return the encrypted data and the salt (needed for decryption)
        return { encrypted, salt };
    }

    static decryptSeedPhrase(
        encryptedSeedPhrase: string,
        password: string,
        salt: string
    ) {
        try {
            const key = this.deriveKey(password, salt); // Derive the key using the same salt
            const bytes = CryptoJS.AES.decrypt(encryptedSeedPhrase, key);
            const seedPhrase = bytes.toString(CryptoJS.enc.Utf8);

            // Check if decryption was successful
            if (!seedPhrase) throw new Error("Decryption failed.");
            return seedPhrase;
        } catch (e: any) {
            console.error("Invalid password or corrupted data:", e.message);
            return null;
        }
    }
    generateSalt = VM.generateSalt
    deriveKey = VM.deriveKey
    encryptSeedPhrase = VM.encryptSeedPhrase
    decryptSeedPhrase = VM.decryptSeedPhrase

    abstract derivationPath: string



    abstract generatePrivateKey(index: number, mnemonic?: string, derivationPath?: string): { privateKey: PrivateKeyType, index: number };
    abstract getTokenInfo(tokenAddress: AddressType, connection: ConnectionType): Promise<TokenInfo>


    // abstract validateAddress(address: AddressType): boolean;
    // abstract getNativeBalance(address: AddressType, connection: ConnectionType): Promise<Balance>;
}
