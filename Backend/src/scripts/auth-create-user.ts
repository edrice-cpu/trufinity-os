import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { db } from '../database';
import { hashPassword } from '../modules/auth/auth.crypto';
import { KnexAuthRepository } from '../modules/auth/auth.repository';
import { loginSchema, newPasswordSchema, normalizeEmail } from '../modules/auth/auth.types';

// Reads the password without echoing it so it never lands in shell history or process listings.
const promptHidden = (question: string): Promise<string> => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const muted = rl as unknown as { _writeToOutput: (text: string) => void };
  let prompted = false;
  muted._writeToOutput = (text: string) => {
    if (!prompted) { process.stdout.write(text); prompted = true; }
  };
  rl.question(question, (answer) => {
    rl.close();
    process.stdout.write('\n');
    resolve(answer);
  });
});

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
  const email = loginSchema.shape.email.safeParse(values.email ?? '');
  if (!email.success) throw new Error('Usage: npm run auth:create-user -- --email <email> [--name "<full name>"]');

  const password = await promptHidden('Password: ');
  const parsedPassword = newPasswordSchema.safeParse(password);
  if (!parsedPassword.success) throw new Error(parsedPassword.error.issues[0]?.message ?? 'Invalid password.');
  if (await promptHidden('Confirm password: ') !== password) throw new Error('Passwords do not match.');

  const fullName = values.name?.trim() ?? '';
  const repository = new KnexAuthRepository();
  const normalizedEmail = normalizeEmail(email.data);
  if (await repository.findUserByEmail(normalizedEmail)) throw new Error('A user with that email already exists.');

  const user = await repository.createUser({
    email: email.data,
    normalizedEmail,
    fullName: fullName.length > 0 ? fullName : null,
    passwordHash: await hashPassword(parsedPassword.data),
  });
  console.log(`Created user ${user.email} (${user.id})`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Failed to create user.');
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
