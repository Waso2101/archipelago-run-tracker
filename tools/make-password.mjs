// Prints ADMIN_PASSWORD_HASH for .env:  node tools/make-password.mjs "your password"
import crypto from "node:crypto";
// The password can also come from the environment (ADMIN_PASSWORD), so it does not show up in the process list.
const pw = process.argv[2] || process.env.ADMIN_PASSWORD;
if (!pw) { console.error('Usage: node tools/make-password.mjs "your password"'); process.exit(1); }
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 32);
// Single quotes: Docker Compose would otherwise read the "$" in the hash as variables.
console.log(`ADMIN_PASSWORD_HASH='scrypt$${salt.toString("hex")}$${hash.toString("hex")}'`);
