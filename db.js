import dotenv from "dotenv";
import { connect } from "@planetscale/database";

dotenv.config();

export const conn = connect({
  host: process.env.DATABASE_HOST,
  username: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD
});
