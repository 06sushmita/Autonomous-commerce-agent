import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../src/dev-server.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleRequest(req, res);
}

