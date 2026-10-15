process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://synclet:synclet@localhost:5434/synclet_test';
process.env.SYNCLET_BACKGROUND = 'off';
