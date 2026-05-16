import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import mediaRouter from "./media";
import proxyRouter from "./proxy";
import scraperRouter from "./scraper";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
// scraper + proxy must be before mediaRouter so /media/scrape and /media/proxy
// aren't swallowed by the /media/:id catch-all
router.use(scraperRouter);
router.use(proxyRouter);
router.use(mediaRouter);

export default router;
