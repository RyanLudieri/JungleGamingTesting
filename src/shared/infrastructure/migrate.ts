import { connectDatabase } from './database';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') throw new Error('Expected migration direction: up or down');
const orm = await connectDatabase();
try {
  if (direction === 'up') await orm.migrator.up();
  else await orm.migrator.down();
} finally {
  await orm.close(true);
}
