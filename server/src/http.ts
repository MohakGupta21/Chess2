import type { NextFunction, Request, Response } from "express";

/**
 * Wrap an async route handler so a rejected promise is forwarded to Express's
 * error middleware instead of becoming an unhandled rejection. Express 4 does
 * not await handlers, so every async handler must go through this.
 */
export function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
