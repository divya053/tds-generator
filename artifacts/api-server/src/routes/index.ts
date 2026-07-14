import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import extractRouter from "./extract";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(requireAuth, extractRouter);

export default router;
