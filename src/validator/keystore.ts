/**
 * @module validator/keystore
 */

import bls from "@chainsafe/bls-js";
import fs from "fs";

import {blsPrivateKeyToHex} from "../util/bytes";
import {encryptKey, decryptKey} from "../util/encrypt";

export interface IKeystoreObject {
  encryptedPrivateKey: string;
  publicKey: string;
}

/**
 * Keystore class which creates and saves bls generated keys
 */
export default class Keystore {
  private encryptedPrivateKey: string;
  public publicKey: string;

  public constructor(keys: IKeystoreObject) {
    this.encryptedPrivateKey = keys.encryptedPrivateKey;
    this.publicKey = keys.publicKey;
  }
  
  public privateKey(password: string): string {
    return decryptKey(this.encryptedPrivateKey, password);
  }
  
  public static generateKeys(password: string): Keystore {
    const keyPair = bls.generateKeyPair();

    const keys: IKeystoreObject = {
      encryptedPrivateKey:encryptKey(blsPrivateKeyToHex(keyPair.privateKey), password),
      publicKey: keyPair.publicKey.toHexString(),
    };

    return new Keystore(keys);
  }

  public static fromJson(filePath: string): Keystore {
    let obj: IKeystoreObject;
    try {
      const data = fs.readFileSync(filePath);
      obj = JSON.parse(data.toString());
    } catch (err) {
      throw new Error(`${filePath} could not be parsed`);
    }

    return new Keystore(obj);
  }

  public saveKeys(outputFilePath: string): void {
    try {
      fs.writeFileSync(outputFilePath, JSON.stringify(this, null, 2));
    } catch (err) {
      throw new Error(`Failed to write to ${outputFilePath}: ${err}`);
    }
  }
}
