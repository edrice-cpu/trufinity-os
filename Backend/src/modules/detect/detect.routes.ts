import { Router } from 'express';
import { devOnlyMiddleware } from '../../middleware/dev-only.middleware';
import { requireAuth } from '../auth/auth.middleware';
import { detectService } from './detect.service';

const router = Router();

router.use(devOnlyMiddleware('Detect test endpoints are only available in development mode'));
// Even in development these hit live third-party APIs / trigger syncs and
// LLM runs, so they also need a signed-in session (401 otherwise).
router.use(requireAuth);

router.post('/run', async (_req, res, next) => {
  try {
    const result = await detectService.run();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export const detectRouter = router;
