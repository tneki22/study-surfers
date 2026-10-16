import assert from "node:assert/strict";
import test from "node:test";
import {
  BAR_BOTTOM,
  BAR_COINS,
  BODY,
  clearsObstacle,
  DECK_HEIGHT,
  DIVE_AFTER,
  GRAVITY,
  HANDCAR_LENGTH,
  handcarMeetOffset,
  HURDLE_COINS,
  HURDLE_CLEARANCE,
  HURDLE_TOP,
  JUMP_SECONDS,
  JUMP_VELOCITY,
  jumpHeight,
  LAUNCH_VELOCITY,
  OBSTACLE_LOOKS,
  planObstacles,
  type PlanInput,
  RAMP_LENGTH,
  RAMP_TOP,
  rampCoins,
  rampFlightSeconds,
  rampFootprint,
  SLIDE_LOW,
  SLIDE_SECONDS,
  slideDepth,
  STEP_UP,
  touchesCoin,
  wagonCoins,
  wagonsLength,
} from "./obstacles";
import { createRng } from "./random";
import { addPoints, initialScore } from "./scoring";

const SPEED = 14;

const plan = (seed: number, input: Partial<PlanInput> & { end: number }) =>
  planObstacles(createRng(seed), { start: 0, speed: SPEED, lanes: 3, more: false, gateIndex: 5, placed: 6, ...input }).rows;

test("на первом вопросе препятствий нет", () => {
  assert.deepEqual(plan(1, { end: SPEED * 8, gateIndex: 1, placed: 0 }), []);
});

test("препятствия — в окне между чтением вопроса и выбором трека у ворот", () => {
  for (let seed = 1; seed < 600; seed += 1) {
    const start = 500;
    const seconds = 4 + (seed % 9);
    const end = start + SPEED * seconds;
    const rows = plan(seed, { start, end, lanes: 3 + (seed % 2), more: seed % 3 === 0, gateIndex: 2 + (seed % 12), placed: seed % 9 });
    for (const row of rows) {
      assert.ok(row.distance >= start + SPEED * 1.1 - 1e-6, `seed ${seed}: слишком рано`);
      assert.ok(row.distance + row.length <= end - SPEED * 1.5 + 1e-6, `seed ${seed}: залезает в окно ворот`);
      assert.ok(row.lane >= 0 && row.lane < 3 + (seed % 2));
      assert.equal(row.length > 0, ["wagons", "ramp", "slope", "handcar"].includes(row.kind));
      if (row.kind === "ramp") assert.equal(row.length, rampFootprint(SPEED));
    }
  }
});

test("знакомство по порядку: стена барьеров, стена балок, вагонетки на всех треках", () => {
  for (const lanes of [3, 4]) {
    const intro = (placed: number) => plan(placed + 7, { end: SPEED * 6, lanes, gateIndex: 2 + placed, placed });
    for (const [placed, kind] of [[0, "hurdle"], [1, "bar"], [2, "wagons"]] as const) {
      const rows = intro(placed);
      assert.deepEqual(rows.map((row) => row.lane).sort(), Array.from({ length: lanes }, (_, lane) => lane));
      assert.ok(rows.every((row) => row.kind === kind), `${placed}: ${rows.map((row) => row.kind)}`);
    }
  }
});

test("короткий вопрос без окна — без препятствий", () => {
  assert.deepEqual(plan(3, { end: SPEED * 2.8 }), []);
});

test("на одном треке между действиями хватает времени, одинаковые облики не стоят рядом", () => {
  let pairs = 0;
  let repeats = 0;
  for (let seed = 1; seed < 1500; seed += 1) {
    const lanes = 3 + (seed % 2);
    const rows = plan(seed, { end: SPEED * (5 + (seed % 8)), lanes, more: seed % 2 === 0, gateIndex: 3 + (seed % 10) });
    for (let lane = 0; lane < lanes; lane += 1) {
      const own = rows.filter((row) => row.lane === lane && row.kind !== "ramp");
      for (let i = 1; i < own.length; i += 1) {
        const [a, b] = [own[i - 1], own[i]];
        const gap = (b.distance - (a.distance + a.length)) / SPEED;
        if (a.kind === "slope") assert.equal(b.kind, "wagons", `seed ${seed}: за пандусом не вагонетки`);
        else if (a.kind === "hurdle" && b.kind === "bar") assert.ok(gap >= DIVE_AFTER - 1e-6, `seed ${seed}: прыжок→подкат ${gap}`);
        else assert.ok(gap >= 0.75 - 1e-6, `seed ${seed}: ${a.kind}→${b.kind} через ${gap.toFixed(2)} с`);
        // Обликов у вида пока по два: если оба заняты соседями по ряду, повтор на треке допустим.
        if (a.kind === b.kind && OBSTACLE_LOOKS[a.kind] > 1) {
          pairs += 1;
          if (a.variant === b.variant) repeats += 1;
        }
      }
    }
    for (const a of rows) {
      for (const b of rows) {
        if (a === b || a.kind !== b.kind || OBSTACLE_LOOKS[a.kind] < 2) continue;
        if (Math.abs(a.lane - b.lane) === 1 && Math.abs(a.distance - b.distance) < 3) assert.notEqual(a.variant, b.variant, `seed ${seed}: рядом одинаковые ${a.kind}`);
      }
    }
  }
  assert.ok(repeats / pairs < 0.1, `повторов облика на треке: ${repeats} из ${pairs}`);
});

/** Сколько клеток и тактов в среднем на вопрос длиной `seconds` после знакомства. */
function density(more: boolean, seconds: number, lanes = 3) {
  let cells = 0;
  let beats = 0;
  let own = 0;
  const runs = 600;
  for (let seed = 1; seed <= runs; seed += 1) {
    const result = planObstacles(createRng(seed), { start: 0, end: SPEED * seconds, speed: SPEED, lanes, more, gateIndex: 9, placed: 9 });
    cells += result.rows.filter((row) => row.kind !== "slope").length;
    beats += result.beats;
    own += result.rows.filter((row) => row.lane === 1 && row.kind !== "slope").length;
  }
  return { cells: cells / runs, beats: beats / runs, own: own / runs };
}

test("плотность: обычный режим заметно гуще прежнего, «Больше препятствий» — примерно вдвое", () => {
  for (const seconds of [6, 8, 10]) {
    const normal = density(false, seconds);
    const more = density(true, seconds);
    assert.ok(normal.beats >= 1.3, `${seconds} с: тактов ${normal.beats}`);
    assert.ok(normal.own >= 0.6, `${seconds} с: на своём треке ${normal.own}`);
    const enough = seconds < 8 ? 1.45 : 1.6;
    assert.ok(more.beats / normal.beats >= enough, `${seconds} с: «больше» ${more.beats} против ${normal.beats}`);
    assert.ok(more.own / normal.own >= enough, `${seconds} с: на своём треке ${more.own} против ${normal.own}`);
  }
});

test("паттерны: испытания — только в режиме «Больше», трамплин и пандус встречаются, у всех обликов есть применение", () => {
  const seen = new Map<string, number>();
  const looks = new Set<string>();
  for (let seed = 1; seed < 2000; seed += 1) {
    const more = seed % 2 === 0;
    const seconds = 5 + (seed % 8);
    for (const row of plan(seed, { end: SPEED * seconds, more, gateIndex: 9, placed: 9, lanes: 3 + (seed % 3 === 0 ? 1 : 0) })) {
      seen.set(`${more}:${row.pattern}`, (seen.get(`${more}:${row.pattern}`) ?? 0) + 1);
      looks.add(`${row.kind}:${row.variant}`);
      if (row.kind === "ramp") assert.ok(row.distance + RAMP_LENGTH + SPEED * rampFlightSeconds() <= SPEED * seconds - SPEED * 1.5 + 1e-6, `seed ${seed}: полёт в окне ворот`);
    }
  }
  for (const name of ["jump-dive", "wall-ladder", "train-double"]) {
    assert.ok(!seen.has(`false:${name}`), `${name} в обычном режиме`);
    assert.ok((seen.get(`true:${name}`) ?? 0) > 20, `${name} в режиме «Больше»`);
  }
  for (const name of ["single", "pair", "wagon", "wall", "ladder", "double", "corridor", "train"]) {
    assert.ok((seen.get(`false:${name}`) ?? 0) > 20, `${name}: ${seen.get(`false:${name}`)}`);
  }
  // Катапульта — только награда, в обычном выборе её нет.
  assert.ok(!seen.has("false:catapult") && !seen.has("true:catapult"));
  for (let look = 0; look < OBSTACLE_LOOKS.hurdle; look += 1) assert.ok(looks.has(`hurdle:${look}`), `барьер ${look}`);
  for (let look = 0; look < OBSTACLE_LOOKS.bar; look += 1) assert.ok(looks.has(`bar:${look}`), `балка ${look}`);
  for (const look of ["wagons:0", "wagons:3", "slope:0", "handcar:0"]) assert.ok(looks.has(look), look);
});

test("награда: катапульта встаёт первым тактом окна на всех треках", () => {
  for (let seed = 1; seed < 300; seed += 1) {
    const result = planObstacles(createRng(seed), { start: 0, end: SPEED * 9, speed: SPEED, lanes: 3 + (seed % 2), more: seed % 2 === 0, gateIndex: 8, placed: 9, reward: true });
    assert.ok(result.rewarded, `seed ${seed}`);
    const ramps = result.rows.filter((row) => row.kind === "ramp");
    assert.equal(ramps.length, 3 + (seed % 2));
    assert.ok(ramps.every((row) => row.pattern === "catapult" && row.beat === 0));
  }
});

test("дрезина: стоянка дальше встречи на handcarMeetOffset, на её треке до стоянки пусто", () => {
  let count = 0;
  for (let seed = 1; seed < 2000; seed += 1) {
    const rows = plan(seed, { end: SPEED * (7 + (seed % 6)), more: true, gateIndex: 9, placed: 9, lanes: 3 + (seed % 2) });
    for (const car of rows.filter((row) => row.kind === "handcar")) {
      count += 1;
      assert.equal(car.length, HANDCAR_LENGTH);
      const meet = car.distance - handcarMeetOffset(SPEED);
      assert.ok(meet >= SPEED * 1.1 - 1e-6, `seed ${seed}: встреча до окна`);
      for (const row of rows) {
        if (row === car || row.lane !== car.lane) continue;
        assert.ok(row.distance + row.length <= meet + 1e-6 || row.distance >= car.distance + car.length - 1e-6, `seed ${seed}: ${row.kind} на пути дрезины`);
      }
    }
  }
  assert.ok(count > 30, `дрезин ${count}`);
});

test("монеты под балкой берутся только подкатом", () => {
  for (const coin of BAR_COINS) {
    assert.equal(touchesCoin(coin.height, 0, false), false);
    assert.equal(touchesCoin(coin.height, 0, true), true);
  }
});

test("на первых вопросах после знакомства — только простые паттерны", () => {
  for (let seed = 1; seed < 400; seed += 1) {
    for (const row of plan(seed, { end: SPEED * 9, more: true, gateIndex: 3, placed: 3 })) {
      assert.ok(["single", "pair", "wagon"].includes(row.pattern), `${row.pattern} на третьем вопросе`);
    }
  }
});

test("баллистика прыжка совпадает с параболой jumpHeight", () => {
  let feet = 0;
  let vy = JUMP_VELOCITY;
  const dt = 1 / 240;
  for (let t = dt; t < JUMP_SECONDS; t += dt) {
    vy -= GRAVITY * dt;
    feet += vy * dt;
    assert.ok(Math.abs(feet - jumpHeight(t / JUMP_SECONDS)) < 0.03, `t=${t.toFixed(3)}`);
  }
});

test("барьер берётся прыжком с запасом над доской, балка — только лёжа", () => {
  assert.ok(HURDLE_CLEARANCE - HURDLE_TOP >= 0.15, "ступни проходят выше доски с запасом");
  assert.equal(clearsObstacle("hurdle", 0, 0), false);
  assert.equal(clearsObstacle("hurdle", jumpHeight(0.5), 0), true);
  assert.equal(clearsObstacle("bar", jumpHeight(0.5), 0), false);
  assert.equal(clearsObstacle("bar", 0, 1), true);
  // Подкат «в последний кадр» не спасает: тело ещё не легло.
  assert.equal(clearsObstacle("bar", 0, slideDepth(0.02)), false);
  // Окно прыжка для барьера — заметная доля секунды, а не кадр.
  let window = 0;
  for (let t = 0; t <= 1; t += 0.001) if (jumpHeight(t) >= HURDLE_CLEARANCE) window += 0.001;
  assert.ok(window * JUMP_SECONDS > 0.44);
  // Окно подката, когда тело ниже балки, — больше половины подката.
  let low = 0;
  for (let t = 0; t <= 1; t += 0.001) if (slideDepth(t) >= SLIDE_LOW) low += 0.001;
  assert.ok(low * SLIDE_SECONDS > 0.5);
  assert.ok(BAR_BOTTOM > BODY.sliding + 0.3);
});

test("на вагонетки заскакивают прыжком, с земли — удар", () => {
  assert.equal(clearsObstacle("wagons", 0, 0), false);
  assert.equal(clearsObstacle("wagons", DECK_HEIGHT - STEP_UP, 0), true);
  // Прыжок с земли достаёт до крыши: окно заскока длиннее трети секунды.
  let window = 0;
  for (let t = 0; t <= 1; t += 0.001) if (jumpHeight(t) >= DECK_HEIGHT - STEP_UP) window += 0.001;
  assert.ok(window * JUMP_SECONDS > 0.35);
});

test("монеты над барьером стоя не собрать, в прыжке — можно", () => {
  for (const coin of HURDLE_COINS) {
    assert.equal(touchesCoin(coin.height, 0, false), false);
    // Прыжок по центру барьера: монета со смещением offset встречается в момент t.
    const t = 0.5 + coin.offset / (SPEED * JUMP_SECONDS);
    assert.equal(touchesCoin(coin.height, jumpHeight(t), false), true, `offset ${coin.offset}`);
  }
});

test("монеты на крышах вагонеток берутся только наверху", () => {
  const length = wagonsLength(2);
  const deck = wagonCoins(length).filter((coin) => coin.offset > 0);
  assert.ok(deck.length >= 5);
  for (const coin of deck) {
    assert.ok(coin.offset < length);
    assert.equal(touchesCoin(coin.height, 0, false), false);
    assert.equal(touchesCoin(coin.height, DECK_HEIGHT, false), true);
  }
});

test("монеты трамплина лежат на траектории броска и берутся в полёте", () => {
  const coins = rampCoins(SPEED);
  assert.ok(coins.length >= 6);
  for (const coin of coins) {
    let feet: number;
    if (coin.offset <= RAMP_LENGTH) feet = (RAMP_TOP * coin.offset) / RAMP_LENGTH;
    else {
      const t = (coin.offset - RAMP_LENGTH) / SPEED;
      feet = RAMP_TOP + LAUNCH_VELOCITY * t - (GRAVITY * t * t) / 2;
    }
    assert.equal(touchesCoin(coin.height, feet, false), true, `offset ${coin.offset}`);
    assert.equal(touchesCoin(coin.height, 0, false) && coin.height > 2, false, "верхние монеты с земли не взять");
  }
  // Бросок заметно выше обычного прыжка.
  assert.ok(RAMP_TOP + (LAUNCH_VELOCITY * LAUNCH_VELOCITY) / (2 * GRAVITY) > 2 * 1.2);
});

test("штраф за препятствие не уводит счёт в минус", () => {
  const state = { ...initialScore(0), score: 10 };
  const outcome = addPoints(state, -25);
  assert.equal(outcome.state.score, 0);
  assert.equal(outcome.delta, -10);
  assert.equal(addPoints(outcome.state, 10).state.score, 10);
});
