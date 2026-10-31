/**
 * One week of running a small business.
 *
 * The teaching happens here, not in a quiz. A student sets a price and buys
 * stock; the week resolves; the numbers move. Nobody tells them that cutting
 * price can raise sales and still lose money — they watch it happen.
 *
 * Every rule is deliberately simple enough that a 14-year-old can follow the
 * arithmetic when the tutor walks them through it. A realistic model they
 * cannot follow teaches nothing.
 */

/** Businesses a student can run. Perishable stock is what makes stock-buying a real decision. */
export const BUSINESSES = {
    tea_stall:  { name: 'Tea stall',      refPrice: 10, unitCost: 4,  baseDemand: 120, weeklyFixed: 400, perishable: true  },
    stationery: { name: 'Stationery shop', refPrice: 50, unitCost: 32, baseDemand: 40,  weeklyFixed: 900, perishable: false },
    tiffin:     { name: 'Tiffin service',  refPrice: 80, unitCost: 52, baseDemand: 35,  weeklyFixed: 700, perishable: true  },
};

/** Weekly events. Each one is a lesson: demand is not something you control. */
export const EVENTS = {
    normal:      { label: 'A normal week',                        demand: 1.0,  cost: 1.0  },
    rain:        { label: 'It rained all week',                   demand: 0.6,  cost: 1.0  },
    festival:    { label: 'Festival week — crowds everywhere',    demand: 1.6,  cost: 1.0  },
    competitor:  { label: 'A new shop opened next door',          demand: 0.75, cost: 1.0  },
    costly_milk: { label: 'Supplier raised prices',               demand: 1.0,  cost: 1.3  },
    exam_week:   { label: 'School exams — students stay home',    demand: 0.8,  cost: 1.0  },
    // The only event that asks instead of tells. Everything else happens to
    // the student; this one makes them choose volume against margin, which is
    // the question every real shop answers every week.
    wedding:     { label: 'A wedding wants a bulk order',         demand: 1.0,  cost: 1.0,  offer: true },
};

/**
 * What coins buy.
 *
 * Until now coins only accumulated — a reward with nothing to spend it on is
 * not a reward. These are the shop equivalent of building houses: profit goes
 * back into capacity.
 *
 * `bigger` deliberately raises rent as well as demand. A growth option with
 * no downside is a cheat code; one that raises your fixed costs is the actual
 * lesson, and it is the only upgrade a student can regret buying.
 */
export const UPGRADES = {
    signboard: { name: 'Signboard',    cost: 30, blurb: 'People can see you from the road.',
                 demand: 1.15, rent: 1,   keeps: false },
    fridge:    { name: 'Fridge',       cost: 50, blurb: 'Nothing you make goes to waste.',
                 demand: 1,    rent: 1,   keeps: true  },
    bigger:    { name: 'Bigger stall', cost: 80, blurb: 'Room for more — and more rent.',
                 demand: 1.30, rent: 1.5, keeps: false },
};

/** Every upgrade a shop owns, collapsed into the three numbers a week needs. */
export function effectsOf(upgrades = []) {
    let demand = 1, rent = 1, keeps = false;
    for (const key of upgrades) {
        const u = UPGRADES[key];
        if (!u) continue;                     // an unknown key changes nothing
        demand *= u.demand;
        rent *= u.rent;
        keeps = keeps || u.keeps;
    }
    return { demand, rent, keeps };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const money = (n) => Math.round(n);

/**
 * How many people want to buy at this price?
 *
 * Linear elasticity around the reference price: halve the price and demand
 * roughly doubles; double it and demand collapses. Not economics-accurate —
 * it is monotonic, obvious, and survives a student setting price to 0 or 9999.
 */
export function demandAt(business, price, eventKey, upgrades = []) {
    const b = BUSINESSES[business];
    if (!b) return 0;
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) return 0;

    const ev = EVENTS[eventKey] || EVENTS.normal;
    const priceFactor = clamp(1 + ((b.refPrice - p) / b.refPrice) * 1.2, 0, 2.5);
    return Math.max(0, Math.round(
        b.baseDemand * priceFactor * ev.demand * effectsOf(upgrades).demand));
}

/**
 * Resolve one week.
 *
 * `cashBefore` matters as much as profit: stock is paid for up front, so a
 * student can post a profit and still run out of money. That gap is the whole
 * point of level 5.
 */
export function simulateWeek({
    business, price, stockBought, cashBefore = 0, event = 'normal',
    upgrades = [], offer = null, takeOffer = false,
}) {
    const b = BUSINESSES[business];
    if (!b) throw new Error('unknown business: ' + business);

    const ev = EVENTS[event] || EVENTS.normal;
    const fx = effectsOf(upgrades);
    const p = Math.max(0, Number(price) || 0);
    const bought = Math.max(0, Math.floor(Number(stockBought) || 0));

    const perishable = b.perishable && !fx.keeps;     // a fridge changes this
    const fixed = money(b.weeklyFixed * fx.rent);     // a bigger stall costs more rent
    const unitCost = money(b.unitCost * ev.cost);
    const stockCost = bought * unitCost;              // paid now, whether or not it sells

    // A bulk order is served first: they asked for a fixed number at a fixed
    // price, and they are standing there. Whatever is left serves the street.
    const deal = takeOffer && offer ? offer : null;
    const bulkSold = deal ? Math.min(deal.qty, bought) : 0;
    const bulkShort = deal ? deal.qty - bulkSold : 0;  // what you could not supply
    const bulkRevenue = bulkSold * (deal ? deal.price : 0);

    const wanted = demandAt(business, p, event, upgrades);
    const sold = Math.min(wanted, bought - bulkSold);

    const revenue = sold * p + bulkRevenue;
    const cogs = (sold + bulkSold) * unitCost;
    const leftover = bought - sold - bulkSold;
    // Perishable stock is thrown away; durable stock carries to next week.
    const spoiled = perishable ? leftover : 0;
    const wasted = spoiled * unitCost;

    const profit = revenue - cogs - wasted - fixed;
    const cashAfter = cashBefore - stockCost - fixed + revenue;

    return {
        event: ev.label,
        wanted, sold, leftover, spoiled,
        unitCost,
        revenue, cogs, wasted,
        fixed,
        bulkSold, bulkShort, bulkRevenue,
        profit,
        cashBefore, cashAfter,
        stockOut: wanted > bought - bulkSold,   // demand you could not serve
        bankrupt: cashAfter < 0,
        carryStock: perishable ? 0 : leftover,
    };
}

/** Units you must sell this week just to cover fixed costs. Level 4. */
export function breakEvenUnits(business, price, event = 'normal', upgrades = []) {
    const b = BUSINESSES[business];
    if (!b) return null;
    const unitCost = money(b.unitCost * (EVENTS[event] || EVENTS.normal).cost);
    const margin = Number(price) - unitCost;
    if (!(margin > 0)) return null;         // selling at or below cost never breaks even
    return Math.ceil(money(b.weeklyFixed * effectsOf(upgrades).rent) / margin);
}
