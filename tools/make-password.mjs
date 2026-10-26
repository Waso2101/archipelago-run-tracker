// Prints ADMIN_PASSWORD_HASH for .env:  node tools/make-password.mjs "your password"
import crypto from "node:crypto";
const pw = process.argv[2];
if (!pw) { console.error('Usage: node tools/make-password.mjs "your password"'); process.exit(1); }
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 32);
console.log(`ADMIN_PASSWORD_HASH=scrypt$${salt.toString("hex")}$${hash.toString("hex")}`);
