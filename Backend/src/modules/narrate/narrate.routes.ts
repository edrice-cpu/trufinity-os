import { Router } from 'express';
import { devOnlyMiddleware } from '../../middleware/dev-only.middleware';
import { narrateService } from './narrate.service';

const router = Router();

router.use(devOnlyMiddleware('Narrate test endpoints are only available in development mode'));

router.post('/run', async (_req, res, next) => {
  try {
    const result = await narrateService.run();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export const narrateRouter = router;
