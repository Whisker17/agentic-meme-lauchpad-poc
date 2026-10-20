// One OS process sending for an account: takes the send lock of <home>, then posts one request to
// a fake sponsor at <url> that refuses (SPONSOR_BUSY) while another request of the account is in
// flight. Prints the sponsor's answer.
import { withSendLock } from "../../src/lock.js";

const [home, url] = process.argv.slice(2) as [string, string];
const answer = await withSendLock(home, async () => (await fetch(url, { method: "POST" })).text());
process.stdout.write(answer);
