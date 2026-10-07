import { Router } from 'express';
import { devOnlyMiddleware } from '../../middleware/dev-only.middleware';
import { detectService } from './detect.service';

const router = Router();

router.use(devOnlyMiddleware('Detect test endpoints are only available in development mode'));

router.post('/run', async (_req, res, next) => {
  try {
    const result = await detectService.run();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export const detectRouter = router;
