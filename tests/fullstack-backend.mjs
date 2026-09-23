/**
 * A throwaway Convex deployment for a full-stack harness: a
 * convex-local-backend on free ports, this repo's functions pushed to it, and
 * a fake OIDC issuer the backend trusts, so a harness can sign people in and
 * every verdict is the real `convex/auth.ts` deciding.
 *
 * Nothing reaches a cloud deployment or a paid API:
 * - `CONVEX_DEPLOYMENT` is masked for every CLI call, and only the
 *   self-hosted variables name a deployment;
 * - the issuer is also the backend's HTTP proxy, so every fetch the backend
 *   makes comes to it: discovery of this issuer, and of the deployment's own
 *   site (the stand-in issuer, `convex/http.ts`), is answered; anything else
 *   is refused and recorded in `outbound`, for the harness to fail on;
 * - the AI keys are unset in this process and every child.
 *
 * Used by comments-surfaces.fullstack.mjs and comments-e2e.fullstack.mjs.
 * Needs a convex-local-backend binary: `CONVEX_LOCAL_BACKEND_BINARY` (or the
 * older `COMMENTS_BACKEND_BINARY`), else the newest under
 * ~/.cache/convex/binaries — which `npx convex dev --local` downloads, and
 * which CI fetches from the pinned release (.github/workflows/check.yml).
 */
import { spawn, execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";

const execFileP = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const AI_KEYS = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"];
for (const key of AI_KEYS) delete process.env[key];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

export async function backendBinary() {
  const named = process.env.CONVEX_LOCAL_BACKEND_BINARY || process.env.COMMENTS_BACKEND_BINARY;
  if (named) return named;
  const root = path.join(homedir(), ".cache", "convex", "binaries");
  const versions = existsSync(root) ? (await readdir(root)).filter((name) => name.startsWith("precompiled-")).sort() : [];
  for (const version of versions.reverse()) {
    const binary = path.join(root, version, "convex-local-backend");
    if (existsSync(binary)) return binary;
  }
  throw new Error("No convex-local-backend binary: run `npx convex dev --local` once, or set CONVEX_LOCAL_BACKEND_BINARY.");
}

/** An RSA key and its JWK set, named by RFC 7638 thumbprint as the app's own script does. */
export function signingPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const kid = createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest("base64url");
  return { privateKey, kid, jwks: { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] } };
}

const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/**
 * Start a deployment. `env` is set on it before the push (the issuer's domain
 * is always set). Resolves once functions are pushed.
 */
export async function startBackend({ name = "fullstack-e2e", env = {}, log = console.log } = {}) {
  const issuerPort = await freePort();
  const issuerUrl = `http://127.0.0.1:${issuerPort}`;
  const [port, sitePort] = [await freePort(), await freePort()];
  const url = `http://127.0.0.1:${port}`;
  const siteUrl = `http://127.0.0.1:${sitePort}`;
  const pair = signingPair();

  const outbound = [];
  const issuer = createServer((request, response) => {
    const target = request.url.startsWith("http") ? new URL(request.url) : null;
    // The deployment verifying its own stand-in tokens: forwarded to its site.
    if (target && target.host === `127.0.0.1:${sitePort}`) {
      const forward = httpRequest({ host: "127.0.0.1", port: sitePort, path: target.pathname + target.search, method: request.method, headers: request.headers }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      forward.on("error", () => { response.statusCode = 502; response.end(); });
      return void request.pipe(forward);
    }
    response.setHeader("content-type", "application/json");
    if (target && target.host !== `127.0.0.1:${issuerPort}`) {
      outbound.push(request.url);
      response.statusCode = 403;
      return void response.end("{}");
    }
    const route = target ? target.pathname : request.url;
    if (route.startsWith("/.well-known/openid-configuration")) {
      response.end(JSON.stringify({
        issuer: issuerUrl, jwks_uri: `${issuerUrl}/.well-known/jwks.json`, authorization_endpoint: `${issuerUrl}/authorize`,
        response_types_supported: ["id_token"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      }));
    } else if (route.startsWith("/.well-known/jwks.json")) {
      response.end(JSON.stringify(pair.jwks));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  issuer.on("connect", (request, socket) => {
    outbound.push(`CONNECT ${request.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((resolve) => issuer.listen(issuerPort, "127.0.0.1", resolve));

  /** A Clerk-shaped session token for `subject`, from the issuer the deployment trusts. */
  const mint = (subject, displayName, extra = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const data = `${b64url({ alg: "RS256", typ: "JWT", kid: pair.kid })}.${b64url({
      iss: issuerUrl, aud: "convex", sub: subject, iat: now, exp: now + 3 * 3600, name: displayName, email: `${subject}@e2e.test`, ...extra,
    })}`;
    return `${data}.${Buffer.from(sign("RSA-SHA256", Buffer.from(data), pair.privateKey)).toString("base64url")}`;
  };

  const work = await mkdtemp(path.join(tmpdir(), `${name}-`));
  const instanceName = name.replace(/[^a-z0-9-]/g, "-");
  const instanceSecret = randomBytes(32).toString("hex");
  const binary = await backendBinary();
  const backendLog = [];
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !AI_KEYS.includes(key) && key !== "CONVEX_DEPLOYMENT"));
  const backend = spawn(binary, [
    path.join(work, "db.sqlite3"),
    "--interface", "127.0.0.1", "--port", String(port), "--site-proxy-port", String(sitePort),
    "--instance-name", instanceName, "--instance-secret", instanceSecret,
    "--local-storage", path.join(work, "storage"), "--disable-beacon",
    "--convex-http-proxy", issuerUrl,
  ], { cwd: work, env: childEnv });
  backend.stdout.on("data", (chunk) => backendLog.push(String(chunk)));
  backend.stderr.on("data", (chunk) => backendLog.push(String(chunk)));

  const envLocal = path.join(repo, ".env.local");
  const hadEnvLocal = existsSync(envLocal);
  // However the run ends — a failure, Ctrl-C, a gate's timeout — the backend
  // goes with it, and so does any `.env.local` the CLI wrote pointing at it
  // (it would win over `.env` for the next Convex command in this checkout).
  const abandon = () => {
    backend.kill("SIGKILL");
    if (!hadEnvLocal && existsSync(envLocal)) rmSync(envLocal);
  };
  process.once("exit", abandon);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      abandon();
      process.exit(1);
    });
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    issuer.close();
    issuer.closeAllConnections?.();
    backend.kill("SIGTERM");
    if (!hadEnvLocal && existsSync(envLocal)) await rm(envLocal);
    await rm(work, { recursive: true, force: true }).catch(() => {});
  };

  try {
    for (let tries = 0; ; tries++) {
      if (await fetch(`${url}/version`).then((r) => r.ok, () => false)) break;
      if (tries > 150) throw new Error(`backend never came up:\n${backendLog.join("")}`);
      await wait(200);
    }
    const { stdout } = await execFileP(binary, ["keygen", "admin-key", "--instance-name", instanceName, "--instance-secret", instanceSecret]);
    const adminKey = stdout.trim();
    const cliEnv = { ...childEnv, CONVEX_DEPLOYMENT: "", CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey };
    const convex = (args) => execFileP(path.join(repo, "node_modules", ".bin", "convex"), args, { cwd: repo, env: cliEnv, maxBuffer: 16 << 20 });
    log(`backend ${url} (site ${siteUrl}), issuer ${issuerUrl}`);
    for (const [key, value] of Object.entries({ CLERK_JWT_ISSUER_DOMAIN: issuerUrl, ...env })) {
      await convex(["env", "set", key, "--", value]);
    }
    await convex(["dev", "--once", "--typecheck", "disable", "--codegen", "disable"]);
    log("functions pushed");

    /** An HTTP client signed in with `jwt` (none: signed out). */
    const client = (jwt) => {
      const made = new ConvexHttpClient(url);
      if (jwt) made.setAuth(jwt);
      return made;
    };
    return { url, siteUrl, issuerUrl, adminKey, outbound, backendLog, mint, client, convex, close };
  } catch (error) {
    await close();
    throw error;
  }
}
