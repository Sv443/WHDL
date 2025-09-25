import { randomBytes } from "node:crypto";
import { styleText } from "node:util";

const { argv } = process;
const args = argv.slice(2);

const amount = args.length > 0 ? Number(args[0]) : 1;
const length = args.length > 1 ? Number(args[1]) : 48;

const generateToken = (len = length) => randomBytes(len).toString("base64url");

let tokenList = "";
for(let i = 0; i < amount; i++)
  tokenList += `${(i > 0 ? "\n" : "")}${amount > 1 ? `${i + 1}) ` : ""}${styleText("blue", generateToken())}`;

console.log(`\n${styleText("green", `Generated token${amount === 1 ? ": " : "s:\n"}`)}${tokenList}\n`);
console.log(styleText("underline", `Add ${amount > 1 ? "these" : "this"} to 'TOKENS' in '.env', separated by a semicolon (;)\n`));
