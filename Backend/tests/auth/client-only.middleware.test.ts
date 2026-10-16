import { describe, expect, it, jest } from '@jest/globals';
import { createRequireClientOnly, type AuthenticatedRequest } from '../../src/modules/auth/auth.middleware';

const makeResponse = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('createRequireClientOnly', () => {
  it('returns 401 when authentication has not populated the request', () => {
    const req = {} as AuthenticatedRequest;
    const res = makeResponse();
    const next = jest.fn();

    createRequireClientOnly('client@trufinity.ca')(req, res as never, next as never);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'Authentication required.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for an authenticated user who is not the configured client', () => {
    const req = {
      auth: { sessionId: 'session-1', user: { id: 'user-1', email: 'employee@trufinity.ca', fullName: null } },
    } as AuthenticatedRequest;
    const res = makeResponse();
    const next = jest.fn();

    createRequireClientOnly('client@trufinity.ca')(req, res as never, next as never);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      message: 'Google Workspace access is restricted to the authorized client.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows the configured client using normalized server-authenticated email', () => {
    const req = {
      auth: { sessionId: 'session-1', user: { id: 'user-1', email: '  CLIENT@TruFinity.ca ', fullName: null } },
    } as AuthenticatedRequest;
    const res = makeResponse();
    const next = jest.fn();

    createRequireClientOnly('client@trufinity.ca')(req, res as never, next as never);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
