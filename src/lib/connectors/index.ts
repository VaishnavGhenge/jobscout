import type { Ats } from "../companies";
import type { Connector } from "./types";
import { greenhouse } from "./greenhouse";
import { lever } from "./lever";
import { ashby } from "./ashby";
import { smartrecruiters } from "./smartrecruiters";
import { rippling } from "./rippling";

export const connectors: Record<Ats, Connector> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  rippling,
};

export type { RawPosting } from "./types";
