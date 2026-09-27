import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import os from "node:os";
import path from "node:path";

export type StaticCredential = {
  kind: "api-key" | "bearer";
  headerName: string;
  value: string;
};

export type OAuthCredential = {
  kind: "oauth";
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
};

export type Credential = StaticCredential | OAuthCredential;

type EncryptedFile = {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function credentialsKey(keyEnvironmentVariable: string, salt: Buffer): Buffer {
  const secret = process.env[keyEnvironmentVariable];
  if (secret === undefined || secret.length < 16) {
    throw new Error(`凭据存储需要 ${keyEnvironmentVariable}，且长度至少为 16 个字符`);
  }
  return scryptSync(secret, salt, 32);
}

export function defaultCredentialPath(userHome = os.homedir()): string {
  return path.join(userHome, ".coding-agent", "credentials.enc.json");
}

export class CredentialStore {
  private readonly filePath: string;
  private readonly keyEnvironmentVariable: string;

  constructor(filePath = defaultCredentialPath(), keyEnvironmentVariable = "CODING_AGENT_CREDENTIAL_KEY") {
    this.filePath = filePath;
    this.keyEnvironmentVariable = keyEnvironmentVariable;
  }

  async read(profileId: string): Promise<Credential | undefined> {
    const values = await this.readAll();
    return values[profileId];
  }

  async set(profileId: string, credential: Credential): Promise<void> {
    if (!/^[a-z0-9_-]{1,64}$/.test(profileId)) throw new Error("凭据 Profile ID 非法");
    const values = await this.readAll();
    values[profileId] = credential;
    await this.writeAll(values);
  }

  async remove(profileId: string): Promise<void> {
    const values = await this.readAll();
    delete values[profileId];
    await this.writeAll(values);
  }

  async metadata(): Promise<string[]> {
    return Object.keys(await this.readAll()).sort();
  }

  private async readAll(): Promise<Record<string, Credential>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`无法读取加密凭据文件: ${error instanceof Error ? error.message : error}`);
    }
    let envelope: EncryptedFile;
    try {
      envelope = JSON.parse(raw) as EncryptedFile;
      if (envelope.version !== 1) throw new Error("不支持的凭据文件版本");
      const salt = Buffer.from(envelope.salt, "base64");
      const decipher = createDecipheriv("aes-256-gcm", credentialsKey(this.keyEnvironmentVariable, salt), Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
      const values = JSON.parse(plaintext) as Record<string, Credential>;
      return values !== null && typeof values === "object" ? values : {};
    } catch (error) {
      throw new Error(`无法解密凭据文件: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async writeAll(values: Record<string, Credential>): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", credentialsKey(this.keyEnvironmentVariable, salt), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    const envelope: EncryptedFile = {
      version: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
  }
}

export function authorizationHeader(credential: Credential | undefined): { name: string; value: string } | undefined {
  if (credential === undefined) return undefined;
  if (credential.kind === "api-key" || credential.kind === "bearer") {
    return { name: credential.headerName, value: credential.value };
  }
  if (credential.kind !== "oauth") return undefined;
  if (credential.accessToken === undefined) return undefined;
  if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) return undefined;
  return { name: "Authorization", value: `${credential.tokenType ?? "Bearer"} ${credential.accessToken}` };
}
