/**
 * 局域网入口的证书（docs/mobile.md 2.1、2.3）：第一次打开局域网入口时在这台电脑上生成一张自签证书，存在数据目录里，以后一直用这张。
 *
 * - 密钥用 Node 自带的 generateKeyPairSync（RSA 2048），证书由 node-forge 签发（X.509 v3、SHA-256、有效期 20 年，CN = `Emaki <serverId>`）；
 * - 存在 `<dataDir>/lan/key.pem`、`cert.pem`；
 * - 指纹 = 证书 DER 的 sha256（Node 的 X509Certificate 解析）。App 配对时认准这个指纹（校验码也用它算，见 pairing.ts），
 *   所以不需要浏览器认可的证书；浏览器访问时会看到一次证书警告（docs/mobile.md 第 10 节 M2）。
 */
import forge from 'node-forge';
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface LanTls {
  key: string;
  cert: string;
  /** 证书 DER 的 sha256（32 字节原始值）：算校验码用 */
  fingerprint: Buffer;
  /** 同上的 hex（状态、二维码里给） */
  fingerprintHex: string;
}

const VALID_YEARS = 20;

/** 证书 DER 的 sha256 */
export function fingerprintOf(certPem: string | Buffer): Buffer {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest();
}

function load(key: string, cert: string): LanTls {
  const fingerprint = fingerprintOf(cert);
  return { key, cert, fingerprint, fingerprintHex: fingerprint.toString('hex') };
}

/** 已经生成过就读出来，没有返回 null（状态里显示指纹用，不生成） */
export function readCert(dir: string): LanTls | null {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (!existsSync(keyFile) || !existsSync(certFile)) return null;
  return load(readFileSync(keyFile, 'utf8'), readFileSync(certFile, 'utf8'));
}

/** 签一张自签证书（RSA 2048、SHA-256、20 年） */
export function createCert(serverId: string, now = Date.now()): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.publicKeyFromPem(publicKey);
  // 序列号：正的随机数（最高位清零，DER 的 INTEGER 不会被当成负数）
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  c.serialNumber = serial.toString('hex');
  // 起始时间往前放一天：手机的时钟慢一点也不会认成「还没生效」
  c.validity.notBefore = new Date(now - 86_400_000);
  c.validity.notAfter = new Date(now);
  c.validity.notAfter.setUTCFullYear(c.validity.notAfter.getUTCFullYear() + VALID_YEARS);
  const subject = [{ name: 'commonName', value: `Emaki ${serverId}` }];
  c.setSubject(subject);
  c.setIssuer(subject);
  c.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  c.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { key: privateKey, cert: forge.pki.certificateToPem(c) };
}

/** 读出这台电脑的证书；没有就生成一张存下来（第一次打开局域网入口时） */
export function loadOrCreateCert(dir: string, serverId: string): LanTls {
  const existing = readCert(dir);
  if (existing) return existing;
  const { key, cert } = createCert(serverId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'key.pem'), key, { mode: 0o600 });
  writeFileSync(path.join(dir, 'cert.pem'), cert);
  return load(key, cert);
}
