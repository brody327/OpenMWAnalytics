import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit reads this to generate/push/migrate the schema in src/db/schema.ts.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
