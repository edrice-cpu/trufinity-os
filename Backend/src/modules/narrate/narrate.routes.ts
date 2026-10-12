import { Router } from 'express';
import { devOnlyMiddleware } from '../../middleware/dev-only.middleware';
import { requireAuth } from '../auth/auth.middleware';
import { narrateService } from './narrate.service';

const router = Router();

router.use(devOnlyMiddleware('Narrate test endpoints are only available in development mode'));
// Even in development these hit live third-party APIs / trigger syncs and
// LLM runs, so they also need a signed-in session (401 otherwise).
router.use(requireAuth);

router.post('/run', async (_req, res, next) => {
  try {
    const result = await narrateService.run();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export const narrateRouter = router;
