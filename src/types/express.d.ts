import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    workerApiKey?: string;
  }

  interface Response {
    flush?: () => void;
  }
}
