// src/engine/discounts.ts
// Discount engine for MK Cycles — sourced from MK_CYCLES_DISCOUNT_CALCULATOR.xlsx
// DO NOT modify the DEFAULT_ constants; they are the canonical source of truth.
// User edits are stored via discountStore and overlay these defaults at runtime.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscountTier {
  minQty: number;        // packages, inclusive
  maxQty: number | null; // packages, inclusive; null = unlimited
  discountPct: number;   // e.g. 2.0 = 2%
}

export interface DiscountCategory {
  id: string;    // stable slug used as map key
  name: string;  // display name (matches Excel exactly)
  tiers: DiscountTier[];
}

export interface LineDiscountResult {
  itemName: string;
  qtyBase: number;
  unitsPerPkg: number;
  packages: number;
  lineAmount: number;
  categoryId: string;
  categoryName: string;
  discountPct: number;
  discountAmount: number;
  tierLabel: string;   // e.g. "1-9 pkgs -> 2%" or "No discount"
}

export interface GroupDiscountSummary {
  categoryId: string;
  categoryName: string;
  totalPackages: number;
  appliedDiscountPct: number;
  totalAmount: number;
  totalDiscount: number;
  groupRuleApplied?: string;  // name of rule applied, if any
  baseTierInfo?: string;      // base tier before rule upgrade
}

export interface VoucherDiscountResult {
  lines: LineDiscountResult[];
  groupSummaries: GroupDiscountSummary[]; // group-wise totals
  totalLineAmount: number;
  totalDiscountAmount: number;
  effectivePct: number; // totalDiscountAmount / totalLineAmount * 100
}

export interface GroupRule {
  id: string;
  name: string;
  categoryIds: string[];  // categories to combine
  minPackages: number;    // if combined packages >= this
  upgradeDiscountPct: number;  // upgrade all items in these categories to this %
}

// ── Default Categories (from Discount Tiers sheet) ────────────────────────────
// Category names match Excel exactly — do not rename.

export const DEFAULT_DISCOUNT_CATEGORIES: DiscountCategory[] = [
  {
    id: "CHAIN_FREEWHEEL_TOGO_DLR",
    name: "CHAIN & FREEWHEEL TOGO/ DLR",
    tiers: [
      { minQty: 1, maxQty: 5,   discountPct: 0.5 },
      { minQty: 6, maxQty: null, discountPct: 2.0 },
    ],
  },
  {
    id: "CHAIN_FREEWHEEL_BIRDI",
    name: "CHAIN & FREEWHEEL BIRDI",
    tiers: [
      { minQty: 1, maxQty: 5,   discountPct: 0.5 },
      { minQty: 6, maxQty: null, discountPct: 1.0 },
    ],
  },
  {
    id: "BELL_CROWN_ALL_TYPES",
    name: "BELL CROWN ALL TYPES",
    tiers: [
      { minQty: 1, maxQty: 4,   discountPct: 1.0 },
      { minQty: 5, maxQty: null, discountPct: 2.0 },
    ],
  },
  {
    id: "PUMP_TOGO_ALL_TYPES",
    name: "PUMP TOGO ALL TYPES",
    tiers: [
      { minQty: 1, maxQty: 4,   discountPct: 1.0 },
      { minQty: 5, maxQty: null, discountPct: 2.0 },
    ],
  },
  {
    id: "SPOKE_ALL_TYPES",
    name: "SPOKE ALL TYPES",
    tiers: [
      { minQty: 2, maxQty: null, discountPct: 2.0 },
    ],
  },
  {
    id: "KW_PRODUCTS",
    name: "KW PRODUCTS",
    tiers: [
      { minQty: 1, maxQty: null, discountPct: 0.5 },
    ],
  },
  {
    id: "LOCK_HERD",
    name: "LOCK HERD",
    tiers: [
      { minQty: 1, maxQty: 4,   discountPct: 2.0 },
      { minQty: 5, maxQty: null, discountPct: 3.0 },
    ],
  },
  {
    id: "LOCK_KIRAN",
    name: "LOCK KIRAN",
    tiers: [
      { minQty: 1, maxQty: 4,   discountPct: 2.0 },
      { minQty: 5, maxQty: null, discountPct: 3.0 },
    ],
  },
  {
    id: "LOCK_EURO",
    name: "LOCK EURO",
    tiers: [
      { minQty: 1, maxQty: 4,   discountPct: 2.0 },
      { minQty: 5, maxQty: null, discountPct: 3.0 },
    ],
  },
  {
    id: "LOCK_CROWN",
    name: "LOCK CROWN",
    tiers: [
      { minQty: 1, maxQty: 4,   discountPct: 2.0 },
      { minQty: 5, maxQty: null, discountPct: 3.0 },
    ],
  },
  {
    id: "TOGO_DOLLAR_SPARES",
    name: "TOGO & DOLLAR SPARES",
    tiers: [
      { minQty: 1,  maxQty: 9,   discountPct: 2.0 },
      { minQty: 10, maxQty: null, discountPct: 3.0 },
    ],
  },
  {
    id: "TOGO_CYCLE_RIMS",
    name: "TOGO CYCLE RIMS",
    tiers: [
      { minQty: 1,  maxQty: 9,   discountPct: 2.0 },
      { minQty: 10, maxQty: 49,  discountPct: 1.0 },
      { minQty: 50, maxQty: null, discountPct: 3.0 },
    ],
  },
  {
    id: "NO_DISCOUNT",
    name: "No Discount",
    tiers: [],
  },
  {
    id: "BICYCLE",
    name: "BICYCLE",
    tiers: [
      { minQty: 10, maxQty: null, discountPct: 1.0 },
    ],
  },
  {
    id: "BICYCLE_LADYBIRD",
    name: "BICYCLE LADYBIRD",
    tiers: [
      { minQty: 5,  maxQty: 9,    discountPct: 1.0 },
      { minQty: 10, maxQty: null, discountPct: 2.0 },
    ],
  },
];

// ── Default Item -> Category Map (all 550 SKUs from Master Lookup sheet) ───────
// Key   = item name uppercased and trimmed (matches Tally itemId)
// Value = category name (matches DiscountCategory.name exactly)
// Items not in this map default to "No Discount".
// Source: MK_CYCLES_DISCOUNT_CALCULATOR.xlsx, sheet "Master Lookup", 550 rows.

export const DEFAULT_ITEM_CATEGORY_MAP: Record<string, string> = {
  "ALLOY WHEEL RIM 3.75 X 12": "No Discount",
  "B B AXLE TOGO PT": "TOGO & DOLLAR SPARES",
  "B B CUP TOGO PT": "TOGO & DOLLAR SPARES",
  "B B CUP TOGO RT": "TOGO & DOLLAR SPARES",
  "B.B. AXLE & CUP BHOGAL PT": "No Discount",
  "B.B. AXLE & CUP BHOGAL RT": "No Discount",
  "B.B. AXLE TOGO RT": "TOGO & DOLLAR SPARES",
  "B.B. FITT DOLLAR PT (ST OF 4)": "No Discount",
  "B.B. FITT TOGO PT (ST OF 4)": "TOGO & DOLLAR SPARES",
  "BABY CAR  TWIST TC 100": "No Discount",
  "BABY CAR BUMBLE BEE DC 110": "No Discount",
  "BABY CAR CIVIC": "No Discount",
  "BABY CAR CONCEPT": "No Discount",
  "BABY CAR F1 RIDE ON": "No Discount",
  "BABY CAR TRANSFORMERS": "No Discount",
  "BABY MARSHAL": "No Discount",
  "BABY RIDEON EVOK 3 IN 1": "No Discount",
  "BABY ROCKER MONKEY RIDE ON": "No Discount",
  "BABY SCOOTER HECTOR": "No Discount",
  "BABY SCOOTER POWER RANGER": "No Discount",
  "BABY SCOOTER SIMBA PLUS": "No Discount",
  "BABY SCOOTER TSC-140": "No Discount",
  "BABY SEAT": "No Discount",
  "BABY TRICYCLE ACE": "No Discount",
  "BABY TRICYCLE ALVIN PARENTAL DLX": "No Discount",
  "BABY TRICYCLE BOXER JADU BB MSC B/W": "No Discount",
  "BABY TRICYCLE BULLET CLASSIC": "No Discount",
  "BABY TRICYCLE CHUCHU RACER BB MSC AMPHA": "No Discount",
  "BABY TRICYCLE DIRT BIKE": "No Discount",
  "BABY TRICYCLE DUNA 3 IN 1": "No Discount",
  "BABY TRICYCLE FUNTRIKE DX": "No Discount",
  "BABY TRICYCLE HUNTER": "No Discount",
  "BABY TRICYCLE HUNTER  ( TT 140 )": "No Discount",
  "BABY TRICYCLE MINI RAMBO": "No Discount",
  "BABY TRICYCLE MOTO CROSS": "No Discount",
  "BABY TRICYCLE MUGAL": "No Discount",
  "BABY TRICYCLE MUGAL 999 MUSIC": "No Discount",
  "BABY TRICYCLE MUGHAL DLX RACER BB MSC AMPHA": "No Discount",
  "BABY TRICYCLE NEXON": "No Discount",
  "BABY TRICYCLE NODDY DX": "No Discount",
  "BABY TRICYCLE PUNCH 4 IN 1": "No Discount",
  "BABY TRICYCLE RACER 2 IN 1": "No Discount",
  "BABY TRICYCLE RACER 3 IN 1": "No Discount",
  "BABY TRICYCLE REGAL": "No Discount",
  "BABY TRICYCLE ROUND RABBIT B/W": "No Discount",
  "BABY TRICYCLE SPEEDY HYBUSA BB MSC AMPHA": "No Discount",
  "BABY TRICYCLE STINGER 2 IN 1": "No Discount",
  "BABY TRICYCLE THUNDER 2 IN 1": "No Discount",
  "BABY TRICYCLE THUNDER THREE IN ONE": "No Discount",
  "BABY TRICYCLE TT-110": "No Discount",
  "BABY TRICYCLE VEGA": "No Discount",
  "BABY TRICYCLE VEGA DX": "No Discount",
  "BABY TRICYCLE VICTOR DX": "No Discount",
  "BABY TRICYCLE WHEEL": "No Discount",
  "BABY WALKER BUNNY ( M )": "No Discount",
  "BABY WALKER BUTTERFLY/ BABYLOVE ( M )": "No Discount",
  "BABY WALKER CLASSIC ( M )": "No Discount",
  "BABY WALKER CRYSTAL DX": "No Discount",
  "BABY WALKER D.H. ( M )": "No Discount",
  "BABY WALKER FROGGY ( M )": "No Discount",
  "BABY WALKER HERBY DX": "No Discount",
  "BABY WALKER KIKI ( TW-130 )": "No Discount",
  "BABY WALKER KITTY CAPSULE": "No Discount",
  "BABY WALKER KITTY CAPSULE HANDLE": "No Discount",
  "BABY WALKER S.H.  ( TIGER  )": "No Discount",
  "BABY WALKER S.H. ( M )": "No Discount",
  "BABY WALKER VENUS DX": "No Discount",
  "BABY WALKER ZOOM ( M )": "No Discount",
  "BABYTRICYCLE HIMALAYAN": "No Discount",
  "BACK FOOT REST PIPE": "TOGO & DOLLAR SPARES",
  "BACK FOOT REST TOGO CP HD": "TOGO & DOLLAR SPARES",
  "BACK STAY KW 20\" RB": "KW PRODUCTS",
  "BACK STAY KW 22''": "KW PRODUCTS",
  "BACK STAY TOGO 20\" RB": "TOGO & DOLLAR SPARES",
  "BACK STAY TOGO 22\"": "TOGO & DOLLAR SPARES",
  "BALL 1/4 TOGO": "TOGO & DOLLAR SPARES",
  "BALL 1/8 TOGO": "TOGO & DOLLAR SPARES",
  "BALL 5/32 TOGO": "TOGO & DOLLAR SPARES",
  "BALL RACER KW 1/8": "KW PRODUCTS",
  "BALL RACER KW 5/32": "KW PRODUCTS",
  "BALL RACER TOGO 1/8": "TOGO & DOLLAR SPARES",
  "BALL RACER TOGO 5\\32": "TOGO & DOLLAR SPARES",
  "BALL TOGO SUPER 6.35MM": "TOGO & DOLLAR SPARES",
  "BASKET KID": "TOGO & DOLLAR SPARES",
  "BASKET PVC HD": "TOGO & DOLLAR SPARES",
  "BATTERY CASE ( METAL HAILONG TYPE )": "No Discount",
  "BELL CROWN": "BELL CROWN ALL TYPES",
  "BELL CROWN GEAR TYPE": "BELL CROWN ALL TYPES",
  "BELL CROWN MINI": "BELL CROWN ALL TYPES",
  "BELL DOLLAR": "TOGO & DOLLAR SPARES",
  "BELL GEAR TYPE ( DLR )": "TOGO & DOLLAR SPARES",
  "BELL GEAR TYPE FULL BLACK": "TOGO & DOLLAR SPARES",
  "BELL LADY DOLLAR": "TOGO & DOLLAR SPARES",
  "BELL LADY TOGO": "TOGO & DOLLAR SPARES",
  "BELL MACHINE LADY DOLLAR": "TOGO & DOLLAR SPARES",
  "BELL MACHINE LADY TOGO": "TOGO & DOLLAR SPARES",
  "BELL MACHINE TOGO": "TOGO & DOLLAR SPARES",
  "BELL T/TONE": "TOGO & DOLLAR SPARES",
  "BELL TOGO": "TOGO & DOLLAR SPARES",
  "BELL TOGO COLOUR MIX": "TOGO & DOLLAR SPARES",
  "BICYCLE ANN EDITION 26T MULTI SPEED": "No Discount",
  "BICYCLE ANN. EDITION 26T": "No Discount",
  "BICYCLE ARROW 26T FF DD SR": "No Discount",
  "BICYCLE ARROW 26T FF DD SR NON IBC": "No Discount",
  "BICYCLE AVIATOR 26T FS AR DD": "No Discount",
  "BICYCLE AVIATOR CARRIER 26T FS AR DD": "No Discount",
  "BICYCLE BASKET": "TOGO & DOLLAR SPARES",
  "BICYCLE BASKET ( BLACK )": "TOGO & DOLLAR SPARES",
  "BICYCLE BASKET EHD": "TOGO & DOLLAR SPARES",
  "BICYCLE BELLA CIAO 26T": "BICYCLE",
  "BICYCLE BERLIN 14T": "BICYCLE",
  "BICYCLE BERLIN 16T": "BICYCLE",
  "BICYCLE BERLIN 20T": "BICYCLE",
  "BICYCLE BERLIN 26T": "BICYCLE",
  "BICYCLE BRAVO 14T X 2.80": "BICYCLE",
  "BICYCLE BRAVO 16T X 2.125": "BICYCLE",
  "BICYCLE BRAVO 20T X 2.125": "BICYCLE",
  "BICYCLE BRAVO 26T X 2.40 IBC": "BICYCLE",
  "BICYCLE CANDY 14X1.75": "BICYCLE",
  "BICYCLE CANDY 16X1.75": "BICYCLE",
  "BICYCLE CITY STAR 14 X 1.75": "BICYCLE",
  "BICYCLE CITY STAR 16 X 1.75": "BICYCLE",
  "BICYCLE DENVOK 16T": "BICYCLE",
  "BICYCLE DENVOK 20T": "BICYCLE",
  "BICYCLE DRIFT / EPIC 24T IBC": "BICYCLE",
  "BICYCLE ELECTRA 26T DD FS AR": "BICYCLE",
  "BICYCLE ELECTRA 26T DD FS CARRIER": "BICYCLE",
  "BICYCLE ELECTRA 26T THREADLESS": "BICYCLE",
  "BICYCLE FIREFLY 26T DD DIAMOND CUT AR": "BICYCLE",
  "BICYCLE FLY CARRIER 26T DD DAR": "BICYCLE",
  "BICYCLE FRONT LIGHT RPL 2255": "BICYCLE",
  "BICYCLE GNT 26T DD FS AR": "BICYCLE",
  "BICYCLE HUB MOTOR E KIT ( 24VOLTS )": "No Discount",
  "BICYCLE HUB MOTOR E KIT ( 36V 250W 36 HOLE )": "No Discount",
  "BICYCLE HUNTER 14X2.80": "BICYCLE",
  "BICYCLE HUNTER 16T": "BICYCLE",
  "BICYCLE KINDER JOY 14X1.75": "BICYCLE",
  "BICYCLE LADYBIRD GLORIUS / MAJESTIC 26T": "BICYCLE",
  "BICYCLE MARCELLA 26T DD FS AR": "BICYCLE",
  "BICYCLE OSLO 24T": "BICYCLE",
  "BICYCLE OSLO 26T DD FS AR MULTI SPEED": "BICYCLE",
  "BICYCLE PABLO / OSLO 26T DD FS AR": "BICYCLE",
  "BICYCLE PABLO 24T": "BICYCLE",
  "BICYCLE PROFESSOR 26T": "BICYCLE",
  "BICYCLE S24 26T X 2.40 FS DD AR T/LESS": "BICYCLE",
  "BICYCLE S24 26T X 2.40 FS DD AR TL IBC": "BICYCLE",
  "BICYCLE SAMSTAR SQUAD 20T": "BICYCLE",
  "BICYCLE SHOTGUN 14T X 2.80": "BICYCLE",
  "BICYCLE SHOTGUN 16T X 2.125": "BICYCLE",
  "BICYCLE SHOTGUN 20T X 2.125": "BICYCLE",
  "BICYCLE SKETCH 14T": "BICYCLE",
  "BICYCLE SKETCH 16T": "BICYCLE",
  "BICYCLE SKETCH 20T TURBO FS DD": "BICYCLE",
  "BICYCLE SKETCH FATBIKE 26T AR DD": "BICYCLE",
  "BICYCLE SKETCH MEGA CARRIER 26T": "BICYCLE",
  "BICYCLE SKETCH TWINS 14 X 1.75": "BICYCLE",
  "BICYCLE SKETCH TWINS 16 X 1.75": "BICYCLE",
  "BICYCLE SKETCH TWINS 20 X 1.75": "BICYCLE",
  "BICYCLE SKETCH TWINS 26T CALIPER BRAKE": "BICYCLE",
  "BICYCLE SNOOPY 14T X 2.80": "BICYCLE",
  "BICYCLE SNOOPY 16T X 2.125": "BICYCLE",
  "BICYCLE SNOOPY 20T X 2.125": "BICYCLE",
  "BICYCLE SPIDERMAN PEARL 14T": "BICYCLE",
  "BICYCLE SPIDERMAN PEARL 16T": "BICYCLE",
  "BICYCLE SPIDERMAN PEARL 20T": "BICYCLE",
  "BICYCLE SPUNK MULTISPEED 700X35C": "BICYCLE",
  "BICYCLE SWAGGER 14T X 2.80": "BICYCLE",
  "BICYCLE SWAGGER 16T X 2.125": "BICYCLE",
  "BICYCLE SWAGGER 20T X 2.125": "BICYCLE",
  "BICYCLE TAIL LIGHT BK-1819": "No Discount",
  "BICYCLE TARZAN 14X1.75": "BICYCLE",
  "BICYCLE TARZAN 16X1.75": "BICYCLE",
  "BICYCLE TARZAN 20X1.75": "BICYCLE",
  "BICYCLE TOGO DRAKE SHOKER 20 X 1.75": "BICYCLE",
  "BICYCLE TOGO ELECTRIC GENTS SIDE MOTOR  24V 10AH SB": "BICYCLE",
  "BICYCLE TOGO HITMAN / PHANTOM 20T": "BICYCLE",
  "BICYCLE TOGO INFINITY 20X1.75": "BICYCLE",
  "BICYCLE TOGO LADY 20\" RB": "BICYCLE",
  "BICYCLE TOGO LADY BLACK": "BICYCLE",
  "BICYCLE TOGO LADY PINK": "BICYCLE",
  "BICYCLE TOGO RAPID 26T": "BICYCLE",
  "BICYCLE TOGO SPEEDO 14 X 1.75": "BICYCLE",
  "BICYCLE TOGO SPEEDO 16X1.75": "BICYCLE",
  "BICYCLE TOGO SPEEDO 20X1.75": "BICYCLE",
  "BICYCLE TOGO SPRINT 20\"": "BICYCLE",
  "BICYCLE TOGO UNICORN 20 X 1.75": "BICYCLE",
  "BICYCLE TOGO UNICORN/ DAISY 26T": "BICYCLE",
  "BICYCLE TOGO UNICORN/ DAISY 26T SLR": "BICYCLE LADYBIRD",
  "BICYCLE TREND 14X1.75": "BICYCLE",
  "BICYCLE TREND 16X1.75": "BICYCLE",
  "BICYCLE TREND 20X1.75": "BICYCLE",
  "BICYCLE TUBE 26X1.5": "No Discount",
  "BICYCLE TURBO CARRIER 26T AR DD": "BICYCLE",
  "BICYCLE TURBO IBC 26T": "BICYCLE",
  "BICYCLE TURBO SUPER 26T DD FS AR": "BICYCLE",
  "BICYCLE TWINS 24T IBC FS DD SR": "BICYCLE",
  "BICYCLE TWINS 26T IBC FS DD SR": "BICYCLE",
  "BICYCLE TYRE 26X1.5": "BICYCLE",
  "BICYCLE VISION MULTISPEED 26T": "BICYCLE",
  "BICYCLE ZIG ZAG 14T": "BICYCLE",
  "BICYCLE ZIG ZAG 16T": "BICYCLE",
  "BICYCLE ZIG ZAG 20T": "BICYCLE",
  "BRAKE CHIMTA BACK PT": "TOGO & DOLLAR SPARES",
  "BRAKE CHIMTA FRONT 20\"": "TOGO & DOLLAR SPARES",
  "BRAKE CHIMTA FRONT PT 22''": "TOGO & DOLLAR SPARES",
  "BRAKE CHIMTA HD": "TOGO & DOLLAR SPARES",
  "BRAKE CLIP DOLLAR PT": "TOGO & DOLLAR SPARES",
  "BRAKE CLIP RK HD": "TOGO & DOLLAR SPARES",
  "BRAKE CLIP TOGO PT": "TOGO & DOLLAR SPARES",
  "BRAKE CLUTCH ALLOY": "TOGO & DOLLAR SPARES",
  "BRAKE CLUTCH KID": "TOGO & DOLLAR SPARES",
  "BRAKE CLUTCH NYLON-427": "TOGO & DOLLAR SPARES",
  "BRAKE CLUTCH SLR": "TOGO & DOLLAR SPARES",
  "BRAKE DRAW BOLT PT": "TOGO & DOLLAR SPARES",
  "BRAKE GUCHHA HT": "TOGO & DOLLAR SPARES",
  "BRAKE PANJA MTB": "TOGO & DOLLAR SPARES",
  "BRAKE PIPE 20''": "TOGO & DOLLAR SPARES",
  "BRAKE PIPE BACK PH 22''": "TOGO & DOLLAR SPARES",
  "BRAKE RUBBER PT": "TOGO & DOLLAR SPARES",
  "BRAKE SET SLR": "TOGO & DOLLAR SPARES",
  "BRAKE SET V BRAKE": "TOGO & DOLLAR SPARES",
  "BRAKE SHOE  ( POWER )": "TOGO & DOLLAR SPARES",
  "BRAKE SHOE +  RUBBER PT": "TOGO & DOLLAR SPARES",
  "BRAKE SHOE + RUBBER EX HD": "TOGO & DOLLAR SPARES",
  "BRAKE SHOE AXN": "TOGO & DOLLAR SPARES",
  "BRAKE SHOE IMPEX": "TOGO & DOLLAR SPARES",
  "BRAKE SHOE MTB": "TOGO & DOLLAR SPARES",
  "BRAKE SHOE SLR TOGO": "TOGO & DOLLAR SPARES",
  "BRAKE SHOE TOGO PT": "TOGO & DOLLAR SPARES",
  "BRAKE WIRE GENTS SLR": "TOGO & DOLLAR SPARES",
  "BRAKE WIRE KID": "TOGO & DOLLAR SPARES",
  "BRAKE WIRE LADY SLR": "TOGO & DOLLAR SPARES",
  "BRAKE WIRE LS PT": "TOGO & DOLLAR SPARES",
  "BRAKE WIRE RANGER": "TOGO & DOLLAR SPARES",
  "CARRIER 20''": "TOGO & DOLLAR SPARES",
  "CARRIER 4 PATTI DOLLAR": "TOGO & DOLLAR SPARES",
  "CARRIER 4 PATTI TOGO": "TOGO & DOLLAR SPARES",
  "CARRIER CLIP": "TOGO & DOLLAR SPARES",
  "CHAIN ADJUSTER TOGO": "TOGO & DOLLAR SPARES",
  "CHAIN BIRDI CYCLE": "CHAIN & FREEWHEEL BIRDI",
  "CHAIN COVER  20X1.75": "TOGO & DOLLAR SPARES",
  "CHAIN COVER 14X1.75": "TOGO & DOLLAR SPARES",
  "CHAIN COVER 16X1.75": "TOGO & DOLLAR SPARES",
  "CHAIN COVER BRUTE MTB": "TOGO & DOLLAR SPARES",
  "CHAIN COVER FITTING": "TOGO & DOLLAR SPARES",
  "CHAIN COVER KW HALF BLACK": "KW PRODUCTS",
  "CHAIN COVER KW HALF BLUE": "KW PRODUCTS",
  "CHAIN COVER KW HALF GREEN": "KW PRODUCTS",
  "CHAIN COVER KW HALF RB": "KW PRODUCTS",
  "CHAIN COVER LADY BIRD": "TOGO & DOLLAR SPARES",
  "CHAIN COVER TOGO 20'' RB": "TOGO & DOLLAR SPARES",
  "CHAIN COVER TOGO 20\" BLUE": "TOGO & DOLLAR SPARES",
  "CHAIN COVER TOGO BLK": "TOGO & DOLLAR SPARES",
  "CHAIN COVER TOGO GR": "TOGO & DOLLAR SPARES",
  "CHAIN DOLLAR CYCLE": "CHAIN & FREEWHEEL TOGO/ DLR",
  "CHAIN JUMBO HD": "CHAIN & FREEWHEEL BIRDI",
  "CHAIN STAY BOLT": "TOGO & DOLLAR SPARES",
  "CHAIN STAY KW 20\" RB": "KW PRODUCTS",
  "CHAIN STAY KW PT BLACK": "KW PRODUCTS",
  "CHAIN STAY TOGO 20\"": "TOGO & DOLLAR SPARES",
  "CHAIN STAY TOGO PT": "TOGO & DOLLAR SPARES",
  "CHAIN TIGER CYCLE": "CHAIN & FREEWHEEL BIRDI",
  "CHAIN TOGO CYCLE": "CHAIN & FREEWHEEL TOGO/ DLR",
  "CHAIN TOGO CYCLE GOLD": "CHAIN & FREEWHEEL TOGO/ DLR",
  "CHAIN TOGO SUPER CYCLE": "CHAIN & FREEWHEEL TOGO/ DLR",
  "CHAIN TOGO SUPER RK": "CHAIN & FREEWHEEL TOGO/ DLR",
  "CHECK NUT KW": "KW PRODUCTS",
  "CLUTCH DANDI": "TOGO & DOLLAR SPARES",
  "CONTROLLER 24V 250W": "No Discount",
  "CONTROLLER 36V 350W": "No Discount",
  "COTTER PIN DOLLAR ST": "No Discount",
  "COTTER PIN TOGO ST": "TOGO & DOLLAR SPARES",
  "CYCLE DISC BRAKE MACHINE": "No Discount",
  "CYCLE LOCK CROWN BLACK": "LOCK CROWN",
  "CYCLE LOCK CROWN BLUE": "LOCK CROWN",
  "CYCLE LOCK CROWN GREEN": "LOCK CROWN",
  "CYCLE LOCK CROWN RB": "LOCK CROWN",
  "CYCLE LOCK EURO BLACK": "LOCK EURO",
  "CYCLE LOCK EURO BLUE": "LOCK EURO",
  "CYCLE LOCK EURO GREEN": "LOCK EURO",
  "CYCLE LOCK EURO RED": "LOCK EURO",
  "CYCLE LOCK IMPEX CP": "LOCK EURO",
  "CYCLE LOCK JUMBO BCP": "LOCK KIRAN",
  "CYCLE LOCK JUMBO BLACK": "LOCK KIRAN",
  "CYCLE LOCK JUMBO BLUE": "LOCK KIRAN",
  "CYCLE LOCK JUMBO GREEN": "LOCK KIRAN",
  "CYCLE LOCK JUMBO RB": "LOCK KIRAN",
  "CYCLE LOCK KIRAN BLACK": "LOCK KIRAN",
  "CYCLE LOCK KIRAN GREEN": "LOCK KIRAN",
  "CYCLE LOCK KIRAN RANGER BLACK": "LOCK KIRAN",
  "CYCLE LOCK KIRAN RED": "LOCK KIRAN",
  "CYCLE LOCK M.A. (GH) BLACK": "LOCK HERD",
  "CYCLE LOCK M.A. (GH) GREEN": "LOCK HERD",
  "CYCLE LOCK M.A. (GH) RED": "LOCK HERD",
  "ELECTRIC BIKE CB 350 PRO EV": "No Discount",
  "ELECTRIC BIKE HIMALAYAN PRO EV": "No Discount",
  "ELECTRIC BIKE MT 15 PRO EV": "No Discount",
  "ELECTRIC CAR WRAGLER PRO EV": "No Discount",
  "FIVE NUT BOLT": "TOGO & DOLLAR SPARES",
  "FORK  TOGO 20\" RB": "TOGO & DOLLAR SPARES",
  "FORK ( SUSPENSION TYPE ) 26T": "No Discount",
  "FORK GUARD DOLLAR 20\"": "No Discount",
  "FORK KW": "KW PRODUCTS",
  "FORK KW 20\" BLACK": "KW PRODUCTS",
  "FORK KW 20\" BLUE": "KW PRODUCTS",
  "FORK KW 20\" RB": "KW PRODUCTS",
  "FORK KW EX STRONG": "KW PRODUCTS",
  "FORK KW PT BLACK": "KW PRODUCTS",
  "FORK KW PT GREEN": "KW PRODUCTS",
  "FORK SUSPENSION 26T THREADLESS": "No Discount",
  "FORK SUSPENSION TYPE 24T": "No Discount",
  "FORK THREAD": "TOGO & DOLLAR SPARES",
  "FORK TOGO 20 X 1.75": "TOGO & DOLLAR SPARES",
  "FORK TOGO 20\" BLUE": "TOGO & DOLLAR SPARES",
  "FORK TOGO FOTAN SLR": "TOGO & DOLLAR SPARES",
  "FORK TOGO GREEN": "TOGO & DOLLAR SPARES",
  "FORK TOGO LADYBIRD PINK": "TOGO & DOLLAR SPARES",
  "FORK TOGO MTB": "TOGO & DOLLAR SPARES",
  "FORKGUARD DOLLAR 22\"": "TOGO & DOLLAR SPARES",
  "FORKGUARD TOGO 20\"": "TOGO & DOLLAR SPARES",
  "FORKGUARD TOGO 22\"": "TOGO & DOLLAR SPARES",
  "FRAME CUP HD": "TOGO & DOLLAR SPARES",
  "FRAME KW 12 BAR": "KW PRODUCTS",
  "FRAME KW 20'' GENTS": "KW PRODUCTS",
  "FRAME KW 20'' LADY": "KW PRODUCTS",
  "FRAME KW 9 BAR": "KW PRODUCTS",
  "FRAME KW CYCLE 22 (D/ BAR)": "KW PRODUCTS",
  "FRAME KW CYCLE 22'' GREEN": "KW PRODUCTS",
  "FRAME KW CYCLE 22\"": "KW PRODUCTS",
  "FRAME KW CYCLE 24''": "KW PRODUCTS",
  "FRAME KW DLX": "KW PRODUCTS",
  "FREE WHEEL BIRDI 18TH": "CHAIN & FREEWHEEL BIRDI",
  "FREE WHEEL BIRDI 18TH FB": "CHAIN & FREEWHEEL BIRDI",
  "FREE WHEEL BIRDI 22TH": "CHAIN & FREEWHEEL BIRDI",
  "FREE WHEEL JAMBO 22TH": "CHAIN & FREEWHEEL BIRDI",
  "FREEWHEEL TOGO 18TH FB": "CHAIN & FREEWHEEL TOGO/ DLR",
  "FREEWHEEL TOGO 18TH SUPER": "CHAIN & FREEWHEEL TOGO/ DLR",
  "GEAR DOLLAR 40 W/O L. CRANK": "TOGO & DOLLAR SPARES",
  "GEAR DOLLAR 40TH": "TOGO & DOLLAR SPARES",
  "GEAR DOLLAR 44 W/O L. CRANK": "TOGO & DOLLAR SPARES",
  "GEAR DOLLAR 44TH": "TOGO & DOLLAR SPARES",
  "GEAR KW 44TH": "KW PRODUCTS",
  "GEAR KW 48TH": "KW PRODUCTS",
  "GEAR TOGO 40TH": "TOGO & DOLLAR SPARES",
  "GEAR TOGO 44 TH": "TOGO & DOLLAR SPARES",
  "GEAR TOGO 48 TH": "TOGO & DOLLAR SPARES",
  "GOLD BAR  (995) GOLD BULLION": "No Discount",
  "HANDLE GRIP 26 X 1.75": "TOGO & DOLLAR SPARES",
  "HANDLE GRIP BLACK PT": "TOGO & DOLLAR SPARES",
  "HANDLE HATHI PH. TYPE": "TOGO & DOLLAR SPARES",
  "HANDLE KW": "KW PRODUCTS",
  "HANDLE KW 20\"": "KW PRODUCTS",
  "HANDLE LEVER HT BACK": "TOGO & DOLLAR SPARES",
  "HANDLE TOGO 20 X 1.75": "TOGO & DOLLAR SPARES",
  "HANDLE TOGO 20\"": "TOGO & DOLLAR SPARES",
  "HANDLE TOGO 26 X 1.75": "TOGO & DOLLAR SPARES",
  "HANDLE TOGO LADYBIRD": "TOGO & DOLLAR SPARES",
  "HANDLE TOGO MONALISA 26 X 1.75": "TOGO & DOLLAR SPARES",
  "HANDLE TOGO PT": "TOGO & DOLLAR SPARES",
  "HANDLE TOGO SUPER EX HD": "TOGO & DOLLAR SPARES",
  "HANDLE TOGO THREADLESS ( WITH STEM)": "TOGO & DOLLAR SPARES",
  "HANDLE WIRE PT": "TOGO & DOLLAR SPARES",
  "HUB AXLE BHOGAL HD": "No Discount",
  "HUB AXLE NUT BACK": "TOGO & DOLLAR SPARES",
  "HUB AXLE TOGO HD": "TOGO & DOLLAR SPARES",
  "HUB CONE BHOGAL BACK": "No Discount",
  "HUB CONE TOGO BACK": "TOGO & DOLLAR SPARES",
  "HUB CUP BHOGAL BACK COLLAR": "No Discount",
  "HUB CUP BHOGAL BACK PLAIN": "No Discount",
  "HUB CUP TOGO B PLAIN": "TOGO & DOLLAR SPARES",
  "HUB CUP TOGO BC": "TOGO & DOLLAR SPARES",
  "HUBS 28 HOLE": "TOGO & DOLLAR SPARES",
  "HUBS 36 HOLE BACK": "TOGO & DOLLAR SPARES",
  "HUBS 36 HOLE FRONT": "TOGO & DOLLAR SPARES",
  "HUBS DOLLAR 14 G PAIR": "TOGO & DOLLAR SPARES",
  "HUBS DOLLAR 14G BACK": "TOGO & DOLLAR SPARES",
  "HUBS DOLLAR 14G FRONT": "TOGO & DOLLAR SPARES",
  "HUBS MEGA": "TOGO & DOLLAR SPARES",
  "HUBS MEGA BACK": "TOGO & DOLLAR SPARES",
  "HUBS MEGA FRONT": "TOGO & DOLLAR SPARES",
  "HUBS TOGO BACK 14G": "TOGO & DOLLAR SPARES",
  "HUBS TOGO PT PAIR": "TOGO & DOLLAR SPARES",
  "LITHIUM CHARGER ( 36V 3Ah )": "No Discount",
  "LITHIUM CHARGER 24V   3AMP": "No Discount",
  "LITHIUM ION BATTERY ( 24V    10Ah )": "No Discount",
  "LITHIUM ION BATTERY ( 24V    13Ah )": "No Discount",
  "LITHIUM ION BATTERY ( 36V    15Ah )": "No Discount",
  "LITHIUM ION BATTERY ( 36V 10Ah )": "No Discount",
  "MUDGUARD BACK PATTI DOLLAR": "TOGO & DOLLAR SPARES",
  "MUDGUARD BACK PATTI TOGO": "TOGO & DOLLAR SPARES",
  "MUDGUARD CLUMP RT": "TOGO & DOLLAR SPARES",
  "MUDGUARD DLR FRONT 20\" SQ RB": "TOGO & DOLLAR SPARES",
  "MUDGUARD DLR LADYBIRD PINK": "TOGO & DOLLAR SPARES",
  "MUDGUARD DLR PAIR 20'' RB SQ": "TOGO & DOLLAR SPARES",
  "MUDGUARD DLR PAIR GREEN": "TOGO & DOLLAR SPARES",
  "MUDGUARD KW FRONT 20\" RB/BLUE": "KW PRODUCTS",
  "MUDGUARD KW FRONT BLACK": "KW PRODUCTS",
  "MUDGUARD KW FRONT CP": "KW PRODUCTS",
  "MUDGUARD KW FRONT GREEN": "KW PRODUCTS",
  "MUDGUARD KW PAIR 20'' RB": "KW PRODUCTS",
  "MUDGUARD KW PAIR 20'' SQ RB": "KW PRODUCTS",
  "MUDGUARD KW PAIR 20\" SQ BLACK": "KW PRODUCTS",
  "MUDGUARD KW PAIR 20SQ BLUE": "KW PRODUCTS",
  "MUDGUARD KW PAIR BLACK": "KW PRODUCTS",
  "MUDGUARD KW PAIR GREEN": "KW PRODUCTS",
  "MUDGUARD PVC 20 X 1.75": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC 26 X 1.75": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC FRONT BLACK": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC FRONT BLUE": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC FRONT GREEN": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC FRONT RB": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC PAIR 20\" BLUE": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC PAIR BLACK": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC PAIR GREEN": "TOGO & DOLLAR SPARES",
  "MUDGUARD PVC PAIR RB": "TOGO & DOLLAR SPARES",
  "MUDGUARD SCREW DLR MIX": "TOGO & DOLLAR SPARES",
  "MUDGUARD SCREW TOGO 1\"": "TOGO & DOLLAR SPARES",
  "MUDGUARD SCREW TOGO 1/2\"": "TOGO & DOLLAR SPARES",
  "MUDGUARD SCREW TOGO 3/4 \"": "TOGO & DOLLAR SPARES",
  "MUDGUARD SCREW TOGO MIX": "TOGO & DOLLAR SPARES",
  "MUDGUARD STICK RANGER": "TOGO & DOLLAR SPARES",
  "MUDGUARD STICKS 20\" ( PCS )": "TOGO & DOLLAR SPARES",
  "MUDGUARD STICKS HD ( PCS )": "TOGO & DOLLAR SPARES",
  "MULTIPURPOSE WIRE LOCK AVERY": "LOCK KIRAN",
  "MULTIPURPOSE WIRE LOCK EURO KING": "LOCK KIRAN",
  "MULTIPURPOSE WIRE LOCK JUMBO": "LOCK KIRAN",
  "MULTIPURPOSE WIRE LOCK NOVA": "LOCK KIRAN",
  "MULTIPURPOSE WIRE LOCK- CROWN": "LOCK KIRAN",
  "MULTIPURPOSE WIRE LOCK- FLEX": "LOCK KIRAN",
  "MULTIPURPOSE WIRE LOCK- KIRAN": "LOCK KIRAN",
  "MULTIPURPOSE WIRE LOCK- KIRAN + ADV": "LOCK KIRAN",
  "MULTIPURPOSE WIRE LOCK- M.A. (GH)": "LOCK KIRAN",
  "PADDLE AXLE 20'' PR": "TOGO & DOLLAR SPARES",
  "PADDLE AXLE PT": "TOGO & DOLLAR SPARES",
  "PADDLE BAR NUT PT": "TOGO & DOLLAR SPARES",
  "PADDLE CONE TOGO PT": "TOGO & DOLLAR SPARES",
  "PADDLE CUP TOGO": "TOGO & DOLLAR SPARES",
  "PADDLE DOLLAR": "TOGO & DOLLAR SPARES",
  "PADDLE DOLLAR 20\"": "TOGO & DOLLAR SPARES",
  "PADDLE RANGER ALLOY": "TOGO & DOLLAR SPARES",
  "PADDLE TOGO 20''": "TOGO & DOLLAR SPARES",
  "PADDLE TOGO HD": "TOGO & DOLLAR SPARES",
  "PADDLE TOGO PVC": "TOGO & DOLLAR SPARES",
  "PADDLE TOGO PVC KID": "TOGO & DOLLAR SPARES",
  "PADDLE TOGO PVC LADYBIRD": "TOGO & DOLLAR SPARES",
  "PRIMIUM HORN ( DH-100 )": "No Discount",
  "PUMP BAHUBALI": "PUMP TOGO ALL TYPES",
  "PUMP BOOM 35MM COLOUR": "PUMP TOGO ALL TYPES",
  "PUMP CONNECTION BLACK TPR 12MM": "PUMP TOGO ALL TYPES",
  "PUMP CONNECTION TOGO": "PUMP TOGO ALL TYPES",
  "PUMP DOLLAR COLOUR": "PUMP TOGO ALL TYPES",
  "PUMP DON2 PRIME BLACK HD": "PUMP TOGO ALL TYPES",
  "PUMP GNT SPARK BCP": "PUMP TOGO ALL TYPES",
  "PUMP GNT SPARK COLOUR": "PUMP TOGO ALL TYPES",
  "PUMP LAZER": "PUMP TOGO ALL TYPES",
  "PUMP TOGO NO 1 BCP": "PUMP TOGO ALL TYPES",
  "PUMP TOGO NO 1 BCP D/NOZZLE": "PUMP TOGO ALL TYPES",
  "PUMP TOGO SUPER": "PUMP TOGO ALL TYPES",
  "REFLECTOR BLACK": "TOGO & DOLLAR SPARES",
  "RIM ALLOY 26 X 1.75": "No Discount",
  "RIM ALLOY 29 X 1.75": "No Discount",
  "RIM DLR": "TOGO CYCLE RIMS",
  "RIM MOTOR CYCLE 2.75 X 18   ( 36 HOLE )": "No Discount",
  "RIM MOTOR CYCLE 300 X 18   ( 36 HOLE )": "No Discount",
  "RIM PUFF  / TOGO 26 X 1.5": "TOGO CYCLE RIMS",
  "RIM PUFF / TOGO": "TOGO CYCLE RIMS",
  "RIM TOGO 26 X 1.3/8 (36 H)": "TOGO CYCLE RIMS",
  "RIM TOGO 26X1/2  ( 36 HOLE )": "TOGO CYCLE RIMS",
  "RIM TOGO 28 X 1.1/2 (36 H)": "TOGO CYCLE RIMS",
  "RIM TOGO EX HD": "TOGO CYCLE RIMS",
  "RIM TOGO RANGER ( 26x1.75 )": "TOGO CYCLE RIMS",
  "RIM TOGO SUPER 2KG": "TOGO CYCLE RIMS",
  "ROD SPOKE TOGO": "No Discount",
  "ROLLER CHAIN ( 08B-1R-10 FEET  )": "No Discount",
  "ROLLER CHAIN ( 08B-1R-3FEET )": "No Discount",
  "RUBBER SOLUTION TOGO ( 113 ML )": "No Discount",
  "SCREW RACER KW 1/8": "KW PRODUCTS",
  "SCREW RACER KW 5/32": "KW PRODUCTS",
  "SCREW RACER TOGO 1/8": "TOGO & DOLLAR SPARES",
  "SCREW RACER TOGO 5/32": "TOGO & DOLLAR SPARES",
  "SEAT BACK PLATE 99": "TOGO & DOLLAR SPARES",
  "SEAT BACK SPRING TOGO": "TOGO & DOLLAR SPARES",
  "SEAT CATCHER DLR": "TOGO & DOLLAR SPARES",
  "SEAT CATCHER TOGO": "TOGO & DOLLAR SPARES",
  "SEAT COMFO": "TOGO & DOLLAR SPARES",
  "SEAT COMMANDO": "TOGO & DOLLAR SPARES",
  "SEAT DOLLAR FOTAN": "TOGO & DOLLAR SPARES",
  "SEAT DOLLAR LADYBIRD": "TOGO & DOLLAR SPARES",
  "SEAT DOLLAR P.U.": "TOGO & DOLLAR SPARES",
  "SEAT FOTAN": "TOGO & DOLLAR SPARES",
  "SEAT FRONT SPRING DOLLAR": "TOGO & DOLLAR SPARES",
  "SEAT FRONT SPRING TOGO": "TOGO & DOLLAR SPARES",
  "SEAT HOOK": "TOGO & DOLLAR SPARES",
  "SEAT JOINT BOLT": "TOGO & DOLLAR SPARES",
  "SEAT LADY BIRD": "TOGO & DOLLAR SPARES",
  "SEAT LATTO TYPE": "TOGO & DOLLAR SPARES",
  "SEAT PILLER": "TOGO & DOLLAR SPARES",
  "SEAT RELEASE DELUX": "TOGO & DOLLAR SPARES",
  "SEAT RELEASE TYPE": "TOGO & DOLLAR SPARES",
  "SEAT RIVIT": "TOGO & DOLLAR SPARES",
  "SEAT SLR BAPPI": "TOGO & DOLLAR SPARES",
  "SEAT SLR DLR": "TOGO & DOLLAR SPARES",
  "SEAT SLR PUFF": "TOGO & DOLLAR SPARES",
  "SEAT SLR TOGO": "TOGO & DOLLAR SPARES",
  "SEAT TOGO GOLD": "TOGO & DOLLAR SPARES",
  "SEAT TOGO KID T-102": "TOGO & DOLLAR SPARES",
  "SEAT TOGO KID T-103": "TOGO & DOLLAR SPARES",
  "SEAT TOGO KID T-104": "TOGO & DOLLAR SPARES",
  "SEAT TOGO NO.2": "TOGO & DOLLAR SPARES",
  "SEAT TOGO P.U.": "TOGO & DOLLAR SPARES",
  "SEAT TOGO P.U. JUNIOR": "TOGO & DOLLAR SPARES",
  "SEAT TOGO PU 106": "TOGO & DOLLAR SPARES",
  "SEAT TOGO PU MTB": "TOGO & DOLLAR SPARES",
  "SEAT TOP PVC": "TOGO & DOLLAR SPARES",
  "SHARI GUARD SILVER": "TOGO & DOLLAR SPARES",
  "SIDE STAND 20 X 1.75": "TOGO & DOLLAR SPARES",
  "SIDE STAND 26 X 1.75 ( SINGLE NUT )": "TOGO & DOLLAR SPARES",
  "SIDE SUPPORT": "TOGO & DOLLAR SPARES",
  "SPOKE DOLLAR 13G": "SPOKE ALL TYPES",
  "SPOKE DOLLAR 13G 26 1/2": "SPOKE ALL TYPES",
  "SPOKE DOLLAR 14G": "SPOKE ALL TYPES",
  "SPOKE DOLLAR 14G 26 1/2": "SPOKE ALL TYPES",
  "SPOKE TOGO 10G HD": "SPOKE ALL TYPES",
  "SPOKE TOGO 12G HD": "SPOKE ALL TYPES",
  "SPOKE TOGO 13G 26 1/2 HD": "SPOKE ALL TYPES",
  "SPOKE TOGO 13G HD": "SPOKE ALL TYPES",
  "SPOKE TOGO 14G 26 1. 3/8 HD": "SPOKE ALL TYPES",
  "SPOKE TOGO 14G 26 1/2 HD": "SPOKE ALL TYPES",
  "SPOKE TOGO 14G HD": "SPOKE ALL TYPES",
  "SPOKE TOGO 14G RANGER": "SPOKE ALL TYPES",
  "THROTTLE DIGITAL": "No Discount",
  "TOOL- FREE OPENER": "No Discount",
  "TOOL- PLIER BOX JT. 10\"": "No Discount",
  "TUBE 2.75 - 17": "No Discount",
  "TUBE 2.75 - 18": "No Discount",
  "TUBE 3.00 - 18": "No Discount",
  "TUBE 3.75-12": "No Discount",
  "TUBE 90/90-12": "No Discount",
  "TYRE 2.75 X 17 FS 183 FIRESTAR": "No Discount",
  "TYRE 2.75 X 17 HARIO": "No Discount",
  "TYRE 2.75 X 18 FS 182 FIRESTAR": "No Discount",
  "TYRE 2.75 X 18 FS 183 FIRESTAR": "No Discount",
  "TYRE 2.75 X 18 HARIO": "No Discount",
  "TYRE 2.75 X 18 TRACKER": "No Discount",
  "TYRE 2.75-17 RIB": "No Discount",
  "TYRE 3.00 X 17 TRACKER": "No Discount",
  "TYRE 3.00 X 18 TRACKER": "No Discount",
  "TYRE 3.75 X 12 FS 182 FIRESTAR": "No Discount",
  "TYRE 3.75 X 12 TRACKER": "No Discount",
  "TYRE 90/90-12 TT": "No Discount",
  // ── Additional items (added from itemCategoryOverrides) ───────────────────────
  "SIDE STAND 16 X 1.75": "TOGO & DOLLAR SPARES",
  "BACK STAY KW 24\"": "KW PRODUCTS",
  "B B AXLE & CUP PT TOGO": "TOGO & DOLLAR SPARES",
  "B.B. AXLE & CUP RT TOGO": "TOGO & DOLLAR SPARES",
  "B.B. AXLE LEE ( RANGER )": "TOGO & DOLLAR SPARES",
  "BICYCLE BASKET ROUND BLUE": "TOGO & DOLLAR SPARES",
  "BICYCLE BASKET ROUND PINK": "TOGO & DOLLAR SPARES",
  "BICYCLE BASKET ROUND SILVER": "TOGO & DOLLAR SPARES",
  "BRAKE PANJA SLR": "TOGO & DOLLAR SPARES",
  "CHAIN STAY KW 20\" BLUE": "KW PRODUCTS",
  "COTTER PIN TOGO OS": "TOGO & DOLLAR SPARES",
  "FORK FITTING TOGO HD": "TOGO & DOLLAR SPARES",
  "FRAME KW 20'' LADY BLUE": "KW PRODUCTS",
  "FRAME KW 20'' LADY RB": "KW PRODUCTS",
  "GEAR DOLLAR 44T W/O L CRANK": "TOGO & DOLLAR SPARES",
  "HUBS TOGO 10G BACK": "TOGO & DOLLAR SPARES",
  "HUBS TOGO 12G BACK": "TOGO & DOLLAR SPARES",
  "MUDGUARD DLR PAIR 20'' BLUE SQ": "TOGO & DOLLAR SPARES",
  "MUDGUARD KW BACK CP": "KW PRODUCTS",
  "MUDGUARD KW FRONT 20\" SQ BLUE": "KW PRODUCTS",
  "MUDGUARD KW FRONT 20\" SQ RB": "KW PRODUCTS",
  "PUMP DON2 PRIME BCP": "PUMP TOGO ALL TYPES",
  "RIM TOGO 26 X 1.1/2  ( 36 HOLE )": "TOGO CYCLE RIMS",
  "RIM TOGO 26 X 1.1/2 BACK": "TOGO CYCLE RIMS",
  "RIM TOGO 26 X 1.1/2 FRONT": "TOGO CYCLE RIMS",
  "RIM TOGO 28 X 1.1/2 BACK": "TOGO & DOLLAR SPARES",
  "RIM  TOGO 28 X 1.1/2 FRONT": "TOGO CYCLE RIMS",
  "RIM TOGO EX HD 10G": "TOGO CYCLE RIMS",
  "RIM TOGO EX HD 12G": "TOGO CYCLE RIMS",
  "RIM TOGO RANGER ( 26X1.75 )": "TOGO CYCLE RIMS",
  "BICYCLE OSLO 26T FS DD AR GREEN": "BICYCLE",
  "BICYCLE OSLO 26T DD FS AR SILVER": "BICYCLE",
  "BICYCLE MARCELLA 26T DD FS AR GREY": "BICYCLE",
  "BICYCLE EPIC 26T IBC": "BICYCLE",
  "BICYCLE EPIC 24T IBC": "BICYCLE",
  "BICYCLE DARK SMOKE 26T  FS DD AR T/LESS IBC": "BICYCLE",
  "BICYCLE DARK SMOKE 24T FS DD AR T/LESS NON IBC": "BICYCLE",
  "BICYCLE DAISY LADYBIRD 26T PINK": "BICYCLE LADYBIRD",
  "BICYCLE DAISY LADYBIRD 26T PEACH": "BICYCLE LADYBIRD",
  "BICYCLE ANN. EDITION 26T WHITE GOLD": "BICYCLE",
  "BICYCLE ANN EDITION 26T MULTI SPEED WHITE": "BICYCLE",
  "BICYCLE ANN EDITION 26T MULTI SPEED BLACK": "BICYCLE",
  "BICYCLE ANN. EDITION 26T BLACK GOLD": "BICYCLE",
};
// Total: 600+ items — canonical list, updated 2026-04-22

// ── Group Rules (special combined category discounts) ─────────────────────────
// These rules allow multiple categories to be considered together for discount upgrades

export const DEFAULT_GROUP_RULES: GroupRule[] = [
  {
    id: "LOCK_COMBO_10PKG",
    name: "LOCK Combo (10+ pkgs → 3%)",
    categoryIds: ["LOCK_HERD", "LOCK_KIRAN", "LOCK_EURO", "LOCK_CROWN"],
    minPackages: 10,
    upgradeDiscountPct: 3.0,
  },
];

// ── Lookup helper ─────────────────────────────────────────────────────────────

/**
 * Resolve the effective DiscountCategory for an item.
 * Lookup order:
 *   1. runtimeOverrides (user changes saved in store — keyed by itemId)
 *   2. DEFAULT_ITEM_CATEGORY_MAP (hardcoded from Excel)
 *   3. "No Discount" fallback
 *
 * itemId = item name uppercased and trimmed (matches CanonicalItem.itemId).
 */
export function resolveCategoryForItem(
  itemId: string,
  runtimeOverrides: Record<string, string>,
  categories: DiscountCategory[]
): DiscountCategory {
  const catName =
    runtimeOverrides[itemId] ??
    DEFAULT_ITEM_CATEGORY_MAP[itemId] ??
    "No Discount";

  return (
    categories.find((c) => c.name === catName) ??
    categories.find((c) => c.id === "NO_DISCOUNT") ??
    { id: "NO_DISCOUNT", name: "No Discount", tiers: [] }
  );
}

// ── Calculation engine (pure, no side effects) ────────────────────────────────

function matchTier(
  packages: number,
  category: DiscountCategory
): { discountPct: number; tierLabel: string } {
  for (const tier of category.tiers) {
    const aboveMin = packages >= tier.minQty;
    const belowMax = tier.maxQty === null || packages <= tier.maxQty;
    if (aboveMin && belowMax) {
      const maxStr = tier.maxQty === null ? "+" : `-${tier.maxQty}`;
      return {
        discountPct: tier.discountPct,
        tierLabel: `${tier.minQty}${maxStr} pkgs -> ${tier.discountPct}%`,
      };
    }
  }
  return { discountPct: 0, tierLabel: "No tier matched" };
}

export function calculateLineDiscount(params: {
  itemId: string;
  itemName: string;
  qtyBase: number;
  unitsPerPkg: number;
  lineAmount: number;
  runtimeOverrides: Record<string, string>;
  categories: DiscountCategory[];
}): LineDiscountResult {
  const { itemId, itemName, qtyBase, unitsPerPkg, lineAmount, runtimeOverrides, categories } = params;

  const upkg = unitsPerPkg > 0 ? unitsPerPkg : 1;
  const packages = qtyBase > 0 ? Math.max(1, Math.floor(qtyBase / upkg)) : 0;

  const category = resolveCategoryForItem(itemId, runtimeOverrides, categories);

  const { discountPct, tierLabel } =
    packages > 0 && category.tiers.length > 0
      ? matchTier(packages, category)
      : {
          discountPct: 0,
          tierLabel: category.tiers.length === 0 ? "No discount" : "Qty is 0",
        };

  return {
    itemName,
    qtyBase,
    unitsPerPkg: upkg,
    packages,
    lineAmount,
    categoryId: category.id,
    categoryName: category.name,
    discountPct,
    discountAmount: (lineAmount * discountPct) / 100,
    tierLabel,
  };
}

export function calculateVoucherDiscount(
  voucher: import("../types/canonical").CanonicalVoucher,
  items: Map<string, import("../types/canonical").CanonicalItem>,
  categories: DiscountCategory[],
  runtimeOverrides: Record<string, string>
): VoucherDiscountResult {
  console.log(`[DISCOUNT] ═══════════════════════════════════════════════════════════`);
  console.log(`[DISCOUNT] Calculating discounts for: ${voucher.voucherNumber} (${voucher.voucherType})`);

  // ─── Phase 1: Group items by category and collect line data ─────────────────

  interface LineInfo {
    itemName: string;
    qtyBase: number;
    unitsPerPkg: number;
    packages: number;
    lineAmount: number;
    categoryId: string;
    categoryName: string;
  }

  interface GroupInfo {
    categoryId: string;
    categoryName: string;
    lineIndices: number[];
    totalPackages: number;
    totalAmount: number;
  }

  const lineData: LineInfo[] = [];
  const groupMap = new Map<string, GroupInfo>();

  console.log(`[DISCOUNT] Phase 1: Grouping items by category...`);

  // First pass: collect all lines and group by category
  for (const line of voucher.lines) {
    if (line.type !== "inventory" || !line.itemId || (line.qtyBase ?? 0) === 0) continue;

    const item = items.get(line.itemId);
    const upkg = (item?.unitsPerPkg ?? 1) > 0 ? (item?.unitsPerPkg ?? 1) : 1;
    const qtyBase = line.qtyBase ?? 0;
    const packages = qtyBase > 0 ? Math.max(1, Math.floor(qtyBase / upkg)) : 0;
    const lineAmount = line.lineAmount ?? 0;

    const category = resolveCategoryForItem(line.itemId, runtimeOverrides, categories);

    // Store line data
    const lineIdx = lineData.length;
    lineData.push({
      itemName: item?.name ?? line.itemId,
      qtyBase,
      unitsPerPkg: upkg,
      packages,
      lineAmount,
      categoryId: category.id,
      categoryName: category.name,
    });

    console.log(`[DISCOUNT]   "${item?.name ?? line.itemId}": qty=${qtyBase}, upkg=${upkg}, pkgs=${packages}, cat=${category.name}`);

    // Accumulate by group
    const key = category.id;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        categoryId: category.id,
        categoryName: category.name,
        lineIndices: [],
        totalPackages: 0,
        totalAmount: 0,
      });
    }
    const group = groupMap.get(key)!;
    group.lineIndices.push(lineIdx);
    group.totalPackages += packages;
    group.totalAmount += lineAmount;
  }

  console.log(`[DISCOUNT] Phase 1 Complete. Groups formed:`, Array.from(groupMap.values()).map((g) => ({
    name: g.categoryName,
    pkgs: g.totalPackages,
    amt: g.totalAmount,
  })));

  // ─── Phase 2: Determine discount % per group based on total packages ─────────
  // Then apply that % to all items in the group

  const lines: LineDiscountResult[] = [];
  const groupSummaries: GroupDiscountSummary[] = [];

  console.log(`[DISCOUNT] Phase 2: Determining discounts per group...`);

  for (const group of groupMap.values()) {
    // Find category definition
    const category = categories.find((c) => c.id === group.categoryId) ||
                     { id: "NO_DISCOUNT", name: "No Discount", tiers: [] };

    // Determine discount % based on group's total packages
    const { discountPct: groupDiscountPct, tierLabel } =
      group.totalPackages > 0 && category.tiers.length > 0
        ? matchTier(group.totalPackages, category)
        : {
            discountPct: 0,
            tierLabel: category.tiers.length === 0 ? "No discount" : "Qty is 0",
          };

    console.log(`[DISCOUNT]   "${group.categoryName}": ${group.totalPackages} pkgs → ${groupDiscountPct}% (${tierLabel})`);

    // Apply this discount to all items in the group
    let groupTotalDiscount = 0;
    for (const lineIdx of group.lineIndices) {
      const item = lineData[lineIdx];
      const discountAmount = (item.lineAmount * groupDiscountPct) / 100;
      groupTotalDiscount += discountAmount;

      lines.push({
        itemName: item.itemName,
        qtyBase: item.qtyBase,
        unitsPerPkg: item.unitsPerPkg,
        packages: item.packages,
        lineAmount: item.lineAmount,
        categoryId: group.categoryId,
        categoryName: group.categoryName,
        discountPct: groupDiscountPct,
        discountAmount,
        tierLabel,
      });
    }

    // Record group summary with base tier info
    const summaryObj: GroupDiscountSummary = {
      categoryId: group.categoryId,
      categoryName: group.categoryName,
      totalPackages: group.totalPackages,
      appliedDiscountPct: groupDiscountPct,
      totalAmount: group.totalAmount,
      totalDiscount: groupTotalDiscount,
      baseTierInfo: tierLabel,
    };
    groupSummaries.push(summaryObj);
  }

  console.log(`[DISCOUNT] Phase 2 Complete. Lines created: ${lines.length}`);

  // ─── Phase 3: Apply Group Rules (upgrade discounts for combined categories) ───

  console.log(`[DISCOUNT RULE] Phase 3 Starting. Groups present:`, Array.from(groupMap.keys()));

  // Check each group rule
  for (const rule of DEFAULT_GROUP_RULES) {
    // Sum packages across all categories in this rule
    const ruleCategories = Array.from(groupMap.values()).filter((g) =>
      rule.categoryIds.includes(g.categoryId)
    );

    console.log(`[DISCOUNT RULE] Evaluating "${rule.name}":`, {
      requiredCategories: rule.categoryIds,
      foundCategories: ruleCategories.map((g) => ({ name: g.categoryName, pkgs: g.totalPackages })),
      totalPkgs: ruleCategories.reduce((s, g) => s + g.totalPackages, 0),
      threshold: rule.minPackages,
    });

    const rulePackages = ruleCategories.reduce((sum, g) => sum + g.totalPackages, 0);

    // If combined packages meet the threshold, upgrade discount
    if (rulePackages >= rule.minPackages) {
      console.log(`[DISCOUNT RULE] ✓ "${rule.name}" triggered! (${rulePackages} >= ${rule.minPackages}) → Applying ${rule.upgradeDiscountPct}%`);

      // Update all lines and group summaries for these categories
      for (let i = 0; i < lines.length; i++) {
        if (rule.categoryIds.includes(lines[i].categoryId)) {
          const oldPct = lines[i].discountPct;
          const oldAmount = lines[i].discountAmount;
          lines[i].discountPct = rule.upgradeDiscountPct;
          lines[i].discountAmount = (lines[i].lineAmount * lines[i].discountPct) / 100;
          lines[i].tierLabel = `${rule.name} → ${rule.upgradeDiscountPct}%`;
          console.log(`[DISCOUNT RULE]   Item "${lines[i].itemName}": ${oldPct}% (₹${oldAmount.toFixed(2)}) → ${lines[i].discountPct}% (₹${lines[i].discountAmount.toFixed(2)})`);
        }
      }

      // Update group summaries
      for (const summary of groupSummaries) {
        if (rule.categoryIds.includes(summary.categoryId)) {
          const oldDiscount = summary.appliedDiscountPct;
          const oldAmount = summary.totalDiscount;
          summary.appliedDiscountPct = rule.upgradeDiscountPct;
          summary.totalDiscount = (summary.totalAmount * summary.appliedDiscountPct) / 100;
          summary.groupRuleApplied = rule.name;
          console.log(`[DISCOUNT RULE]   Group "${summary.categoryName}": ${oldDiscount}% (₹${oldAmount.toFixed(2)}) → ${summary.appliedDiscountPct}% (₹${summary.totalDiscount.toFixed(2)})`);
        }
      }
    } else {
      console.log(`[DISCOUNT RULE] ✗ "${rule.name}" NOT triggered (${rulePackages} < ${rule.minPackages})`);
    }
  }

  const totalLineAmount = lineData.reduce((s, l) => s + l.lineAmount, 0);
  const totalDiscountAmount = lines.reduce((s, l) => s + l.discountAmount, 0);
  const effectivePct = totalLineAmount > 0 ? (totalDiscountAmount / totalLineAmount) * 100 : 0;

  console.log(`[DISCOUNT] ═══════════════════════════════════════════════════════════`);
  console.log(`[DISCOUNT] Final Result:`, {
    totalSubtotal: totalLineAmount,
    totalDiscount: totalDiscountAmount,
    effectiveRate: `${effectivePct.toFixed(2)}%`,
    rulesApplied: groupSummaries.filter((g) => g.groupRuleApplied).map((g) => g.groupRuleApplied),
  });
  console.log(`[DISCOUNT] ═══════════════════════════════════════════════════════════`);

  return { lines, groupSummaries, totalLineAmount, totalDiscountAmount, effectivePct };
}
