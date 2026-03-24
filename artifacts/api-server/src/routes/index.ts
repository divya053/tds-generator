import { Router, type IRouter } from "express";
import healthRouter from "./health";
import extractRouter from "./extract";

const router: IRouter = Router();

router.use(healthRouter);
router.use(extractRouter);

export default router;
