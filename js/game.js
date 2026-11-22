// 75球式ビンゴの計算。画面表示と保存は、各画面のスクリプトが担当する。
// 進行役は createNumberPool で準備し、抽選のたびに drawOne の戻り値を使う。
// 参加者は createCard で配置を作り、抽選履歴から開いたマスとビンゴを判定する。
// 報告を受け取った進行役は、開始時に確定したカードと履歴で結果を照合する。
const BINGO_BALL_COUNT = 75;
const BINGO_CARD_SIZE = 5;
const BINGO_COLUMN_SIZE = 15;
const BINGO_CENTER = 2;
const BINGO_FREE = "FREE";

// 手順1　ゲーム開始時のプールを作る。引数を渡すとカードの列の候補も作れる。
function createNumberPool(start = 1, end = BINGO_BALL_COUNT) {
    if (!Number.isInteger(start) || !Number.isInteger(end)
        || start < 1 || end > BINGO_BALL_COUNT || start > end) {
        throw new RangeError("番号の範囲は1〜75の整数で指定してください。");
    }

    const numbers = [];
    for (let num = start; num <= end; num++) {
        numbers.push(num);
    }
    return numbers;
}

// 手順2　1球引き、抽選後の残り球と履歴を返す。空なら undefined を返す。
function drawOne(numbers, drawHistory) {
    const remaining = validateBallList(numbers, "残り球");
    const drawn = validateBallList(drawHistory, "抽選履歴");
    for (const number of remaining) {
        if (drawn.has(number)) {
            throw new RangeError("抽選済みの番号が残り球に含まれています。");
        }
    }
    if (numbers.length === 0) {
        return undefined;
    }

    // 呼び出し元は保存に成功するまで抽選前の配列を使い続けられる。
    const nextNumbers = numbers.slice();
    // 乱数で選ぶのは球の位置。splice が返す1個入りの配列から球番号を取り出す。
    const position = Math.floor(Math.random() * nextNumbers.length);
    const pickedNumber = nextNumbers.splice(position, 1)[0];
    const nextHistory = drawHistory.slice();
    nextHistory.push(pickedNumber);
    return { pickedNumber, nextNumbers, nextHistory };
}

// 手順3　各列の候補を毎回作り、残っている候補から重複なく選ぶ。
function createColumn(start, end, count) {
    const candidates = createNumberPool(start, end);
    if (!Number.isInteger(count) || count < 0 || count > candidates.length) {
        throw new RangeError("引く個数は0から候補の個数までの整数で指定してください。");
    }

    const column = [];
    for (let i = 0; i < count; i++) {
        const position = Math.floor(Math.random() * candidates.length);
        column.push(candidates.splice(position, 1)[0]);
    }
    return column;
}

function createCard() {
    const bColumn = createColumn(1, 15, 5);
    const iColumn = createColumn(16, 30, 5);
    const nColumn = createColumn(31, 45, 4);
    // 位置2にFREEを差し込み、引いた4個の数字はすべて残す。
    nColumn.splice(BINGO_CENTER, 0, BINGO_FREE);
    const gColumn = createColumn(46, 60, 5);
    const oColumn = createColumn(61, 75, 5);

    // 同じ段からB・I・N・G・Oの順に1マスずつ取って横1行を作る。
    const cardRows = [];
    for (let row = 0; row < BINGO_CARD_SIZE; row++) {
        cardRows.push([bColumn[row], iColumn[row], nColumn[row], gColumn[row], oColumn[row]]);
    }
    return cardRows;
}

function validateBallList(numbers, label) {
    if (!Array.isArray(numbers)) {
        throw new TypeError(`${label}は番号の配列である必要があります。`);
    }

    const uniqueNumbers = new Set();
    for (const number of numbers) {
        if (!Number.isInteger(number) || number < 1 || number > BINGO_BALL_COUNT) {
            throw new RangeError(`${label}には1〜75の整数だけを指定してください。`);
        }
        if (uniqueNumbers.has(number)) {
            throw new RangeError(`${label}に${number}番が重複しています。`);
        }
        uniqueNumbers.add(number);
    }
    return uniqueNumbers;
}

// 復元した配置は、行数・列の番号範囲・中央のFREE・重複を確認してから使う。
function validateCard(cardRows) {
    if (!Array.isArray(cardRows) || cardRows.length !== BINGO_CARD_SIZE) {
        throw new TypeError("ビンゴカードには5行が必要です。");
    }

    const seen = new Set();
    for (let row = 0; row < BINGO_CARD_SIZE; row++) {
        const cells = cardRows[row];
        if (!Array.isArray(cells) || cells.length !== BINGO_CARD_SIZE) {
            throw new TypeError(`カードの${row + 1}行目には5マスが必要です。`);
        }

        for (let col = 0; col < BINGO_CARD_SIZE; col++) {
            const cell = cells[col];
            if (row === BINGO_CENTER && col === BINGO_CENTER) {
                if (cell !== BINGO_FREE) {
                    throw new RangeError("カードの中央にはFREEが必要です。");
                }
                continue;
            }

            const min = col * BINGO_COLUMN_SIZE + 1;
            const max = min + BINGO_COLUMN_SIZE - 1;
            if (!Number.isInteger(cell) || cell < min || cell > max) {
                throw new RangeError(`${row + 1}行${col + 1}列目には${min}〜${max}の整数が必要です。`);
            }
            if (seen.has(cell)) {
                throw new RangeError(`カードに${cell}番が重複しています。`);
            }
            seen.add(cell);
        }
    }
}

// 手順4　カードと同じ行・列の位置に true または false を入れて返す。
// カードと履歴が壊れていれば、理由を含むエラーを呼び出し元へ渡す。
function isOpen(cell, history) {
    return cell === BINGO_FREE || history.includes(cell);
}

function getOpenCells(cardRows, history) {
    validateCard(cardRows);
    validateBallList(history, "抽選履歴");

    // 行ごとに結果用の配列を作り、判定したマスを元の配置と同じ順番で追加する。
    const openCells = [];
    for (const row of cardRows) {
        const rowStates = [];
        for (const cell of row) {
            rowStates.push(isOpen(cell, history));
        }
        openCells.push(rowStates);
    }
    return openCells;
}

// 手順5　12本のうち最も早く完成した回を返す。未成立なら firstBingoAt は null。
function getCardResult(cardRows, history) {
    const openCells = getOpenCells(cardRows, history);
    // 横5本を出発点として、縦5本と斜め2本を加える。
    const lines = cardRows.slice();
    const diagonalDown = [];
    const diagonalUp = [];

    for (let index = 0; index < BINGO_CARD_SIZE; index++) {
        const column = [];
        for (const row of cardRows) {
            column.push(row[index]);
        }
        lines.push(column);
        diagonalDown.push(cardRows[index][index]);
        diagonalUp.push(cardRows[index][BINGO_CARD_SIZE - 1 - index]);
    }
    lines.push(diagonalDown, diagonalUp);

    // 履歴の位置0は第1回。FREEは抽選前から開いているので第0回として扱う。
    const openedAt = new Map(history.map((number, index) => [number, index + 1]));
    openedAt.set(BINGO_FREE, 0);

    // 1本の完成回は、その線で最後に開いたマスの回。未抽選のマスがあれば未完成。
    let earliestRound = Infinity;
    for (const line of lines) {
        let completedAt = 0;
        for (const cell of line) {
            completedAt = Math.max(completedAt, openedAt.get(cell) ?? Infinity);
        }
        earliestRound = Math.min(earliestRound, completedAt);
    }

    const hasBingo = Number.isFinite(earliestRound);
    return { openCells, hasBingo, firstBingoAt: hasBingo ? earliestRound : null };
}

function hasCardIdentity(card) {
    return typeof card?.gameId === "string" && card.gameId.trim() !== ""
        && typeof card.cardId === "string" && card.cardId.trim() !== "";
}

// 手順6　カード本人の報告。card は gameId・cardId・cardRows を持つ。
function createCardReport(card, history) {
    if (!hasCardIdentity(card)) {
        throw new TypeError("報告にはゲームIDとカードIDが必要です。");
    }
    const { hasBingo, firstBingoAt } = getCardResult(card.cardRows, history);
    return {
        gameId: card.gameId,
        cardId: card.cardId,
        checkedDrawCount: history.length,
        hasBingo,
        firstBingoAt,
    };
}

// 進行役の照合。card は開始時に確定した参加カードで、history は対象回までの履歴。
// 待機時間を過ぎてから allowFallback を true にすると、未応答分を代替照合する。
function checkCardReport(card, history, report, { allowFallback = false } = {}) {
    const pending = (reason) => ({ status: "unconfirmed", reason });
    if (!hasCardIdentity(card)) {
        return pending("参加カードのゲームIDまたはカードIDがありません。");
    }
    if (!Array.isArray(history)) {
        return pending("抽選履歴を読み込めません。");
    }

    const targetRound = history.length;
    if (report != null) {
        if (report.gameId !== card.gameId || report.cardId !== card.cardId) {
            return pending("確認報告のゲームIDまたはカードIDが一致しません。");
        }
        const reportedRound = report.checkedDrawCount;
        if (!Number.isInteger(reportedRound) || reportedRound < 0 || reportedRound > targetRound) {
            return pending("確認報告の抽選回数が正しくありません。");
        }
        const validFirstBingo = report.hasBingo === true
            ? Number.isInteger(report.firstBingoAt) && report.firstBingoAt > 0 && report.firstBingoAt <= reportedRound
            : report.hasBingo === false && report.firstBingoAt === null;
        if (!validFirstBingo) {
            return pending("確認報告のビンゴ結果が正しくありません。");
        }
    }

    const awaitingReport = report == null || report.checkedDrawCount < targetRound;
    if (awaitingReport && !allowFallback) {
        return pending("対象回までの確認報告を待っています。");
    }

    let checked;
    try {
        checked = createCardReport(card, history);
    } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
            return pending(error.message);
        }
        throw error;
    }

    // 本人から対象回の報告が来た場合は、進行役の再計算と一致したときに確定する。
    if (!awaitingReport && (report.hasBingo !== checked.hasBingo || report.firstBingoAt !== checked.firstBingoAt)) {
        return pending("確認報告のビンゴ結果が抽選履歴と一致しません。");
    }

    const displayName = typeof card.displayName === "string" ? card.displayName.trim() : "";
    return {
        ...checked,
        status: awaitingReport ? "fallback-confirmed" : "card-confirmed",
        displayName: displayName || card.cardId,
    };
}

// 照合済みの当選者を初ビンゴ回でまとめる。同じ回のカードは同着。
function groupBingoWinners(checkedCards) {
    const byCard = new Map();
    for (const result of checkedCards) {
        const confirmed = result.status === "card-confirmed" || result.status === "fallback-confirmed";
        if (!confirmed || !result.hasBingo) {
            continue;
        }

        // 同じカードの再報告や代替照合は、ゲームIDとカードIDの組で1件にまとめる。
        const cardKey = JSON.stringify([result.gameId, result.cardId]);
        const previous = byCard.get(cardKey);
        if (!previous || result.firstBingoAt < previous.firstBingoAt) {
            byCard.set(cardKey, result);
        }
    }

    const ordered = [...byCard.values()].sort((a, b) =>
        a.firstBingoAt - b.firstBingoAt
        || a.gameId.localeCompare(b.gameId)
        || a.cardId.localeCompare(b.cardId));
    const groups = [];
    for (const winner of ordered) {
        if (groups.at(-1)?.firstBingoAt !== winner.firstBingoAt) {
            groups.push({ firstBingoAt: winner.firstBingoAt, cards: [] });
        }
        groups.at(-1).cards.push({
            gameId: winner.gameId,
            cardId: winner.cardId,
            displayName: winner.displayName,
        });
    }
    return groups;
}
