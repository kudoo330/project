import { pbkdf2Sync, randomBytes } from 'node:crypto';
import readline from 'node:readline';
if (!process.stdin.isTTY) {
  process.stderr.write('请在交互终端运行；密码不会显示。\n');
  process.exit(1);
}
process.stdout.write('输入新密码（至少12位，不回显）：');
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
let password = '';
process.stdin.on('keypress', (text, key) => {
  if (key.ctrl && key.name === 'c') process.exit(1);
  if (key.name === 'backspace') password = password.slice(0, -1);
  else if (key.name === 'return') {
    process.stdin.setRawMode(false);
    if (password.length < 12) { process.stderr.write('\n密码至少12位。\n'); process.exit(1); }
    const salt = randomBytes(16).toString('hex');
    const hash = pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
    process.stdout.write(`\npbkdf2$100000$${salt}$${hash}\n`);
    process.exit(0);
  } else if (text && !key.ctrl && !key.meta) password += text;
});
