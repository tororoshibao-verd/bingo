// 最初に書くファイル。数字と配列だけで、ビンゴのルールを試します。
// まず手順1だけ書き、ブラウザーの開発者ツールのコンソールで結果を確認してください。
// 書く順番は game.js → storage.js → draw.js の準備・発行 → card.js の登録・受信
// → draw.js の照合・終了です。各手順で一度止まり、例のとおりになるか試します。
// game.js が受け取るのは数値や配列です。HTML要素の取得、ボタンクリック、保存は
// 呼び出し元に任せると、抽選画面とカード画面で同じ判定を使えます。

// 手順1　1〜75を for で配列に用意する
let numbers = [];
for (let i = 1; i <= 75; i++) {
  numbers.push(i);
}

// 手順2　1回分の抽選を考える（先に手順1）

let drawHistory = []; // 選ばれた番号の履歴を保存する配列
function drawOne(numbers, drawHistory) {
    if (numbers.length === 0) {
        console.log("すべて抽選済み");
    } else {
        const nextNumbers = numbers.slice(); // 残りの番号のコピーを作る
        const r = Math.floor(Math.random() * numbers.length); // 乱数で1個の位置を決める
        const selectedNumbers = nextNumbers.splice(r, 1); // 選ばれた番号の履歴を保存する配列
        const nextHistory = drawHistory.slice(); // 履歴のコピーを作る
        nextHistory.push(selectedNumbers[0]); // 履歴に追加
        return {
            pickedNumber: selectedNumbers[0], nextNumbers, nextHistory // 選ばれた番号
        };
    }
}
// 確認用。1周につき1球を引き、76回目に球が出ないことまで試す。
for (let attempt = 1; attempt <= 76; attempt++) {
    const result = drawOne(numbers, drawHistory);

    // 球が空のときは結果が返らないので、今の残り球と履歴を保って終了する。
    if (result === undefined) {
        // console.log(`${attempt}回目　残り${numbers.length}球・履歴${drawHistory.length}件`);
        break;
    }

    // 今回の結果を、次の周で使う残り球と履歴にする。
    numbers = result.nextNumbers;
    drawHistory = result.nextHistory;
    // console.log(`${attempt}回目　${result.pickedNumber}番・残り${numbers.length}球・履歴${drawHistory.length}件`);
}

// 手順3
function createColumn(start, end, count) {
    let candidates = [];
    for (let num = start; num <= end; num++) {
        candidates.push(num);
    };

    let column = [];
    for (let i = 0; i < count; i++) {
        const r = Math.floor(Math.random() * candidates.length);
        const selectedNumbers = candidates.splice(r, 1);
        column.push(selectedNumbers[0]);
    };
    return column;
}

function createCard() {
    const bColumn = createColumn(1, 15, 5);
    const iColumn = createColumn(16, 30, 5);
    const nColumn = createColumn(31, 45, 4);
    nColumn.splice(2, 0, "FREE");
    const gColumn = createColumn(46, 60, 5);
    const oColumn = createColumn(61, 75, 5);

    const firstRow = [bColumn[0], iColumn[0], nColumn[0], gColumn[0], oColumn[0]];
    // console.log(firstRow);
    const secondRow = [bColumn[1], iColumn[1], nColumn[1], gColumn[1], oColumn[1]];
    // console.log(secondRow);
    const thirdRow = [bColumn[2], iColumn[2], nColumn[2], gColumn[2], oColumn[2]];
    // console.log(thirdRow);
    const fourthRow = [bColumn[3], iColumn[3], nColumn[3], gColumn[3], oColumn[3]];
    // console.log(fourthRow);
    const fifthRow = [bColumn[4], iColumn[4], nColumn[4], gColumn[4], oColumn[4]];
    // console.log(fifthRow);

    const cardRows = [firstRow, secondRow, thirdRow, fourthRow, fifthRow]; 
    return cardRows;
}
const firstCard = createCard();
console.table(firstCard);
const firstCardBefore = JSON.stringify(firstCard);
const secondCard = createCard();

console.table(secondCard);
console.log("1枚目の配置はそのまま？", JSON.stringify(firstCard) === firstCardBefore);

// 手順3　初回発行用に、1枚分のカードの配置を作る（先に手順2の「1個選んで除く」考え方）
// 席決めアプリの「席の位置」と「座る人」を、ここでは「マスの位置」と「入る番号」に置き換えます。
// 紙に5行×5列を描きます。左から B は1〜15、I は16〜30、N は31〜45、
// G は46〜60、O は61〜75。列を作るたびに、その列用の候補15個を準備します。
// 列内のマスを上から順に埋めながら、毎回残った候補から均等に1個選び取り除きます。
// N列の3行目だけは中央FREEを置き、候補の取り出しを休みます。並べ替えずに選んだ順を使います。
// 返すものは「行ごとに5マスが入る、5行分の配置」。毎回新しい行と候補配列を用意しましょう。
// 確認　1枚の中に異なる数字24個と中央FREEがあるか。違う1枚を作っても、前の1枚は変わりませんか？
// 別カード同士は同じ数字を使えます。偶然すべて一致しても再抽選しません。
// この生成を呼ぶのは、準備中に発行済みのURLを初めて開いた card.js です。カード側で配置を
// 「未登録」として保存します。同じURLの再表示や、後で名前を登録するときはその配置を使います。

// 手順4　保存された配置と履歴から、どのマスが開くか調べる（先に手順2・3）
// カード画面の復元と、進行役の代替照合で同じ答えを出すための準備です。
// 配置が5×5か、FREEの位置、数字の範囲・重複、履歴が1〜75の異なる整数かを先に確かめます。
// 不正な入力は理由と一緒に呼び出し元へ返し、判定を止めます。保存の欠損と未当選を区別します。
// 各マスを for でたどり、if で「中央か、数字が履歴に含まれるか」を考えます。
// 返すものは各位置の開閉が分かる結果。元の配置はそのまま使い、開閉は毎回履歴から再現します。
// 確認　履歴が空なら開くのはFREEだけ。カードにない番号を引いたときは開くマスが増えません。

// 手順5　12本を判定し、最初にそろった回を求める（先に手順4）
// 横5本・縦5本・斜め2本を紙に描き、それぞれどの5マスを調べるのか印を付けます。
// まず1本のすべてが開いたかを調べ、次に同じ考え方を12本に広げてみましょう。
// カードを閉じていた間にビンゴした場合にも、実際にそろった抽選回を見つける必要があります。
// 履歴を古い順に1回分ずつ増やして手順4の結果を調べ、初めて1本完成した回を覚えます。
// 呼び出し元に返すのはビンゴの有無と、最初の成立回 firstBingoAt。未成立なら回数は null とします。
// 中央の行が「3・17・FREE・59・68」のカードで試しましょう。3、17、59の時点では横は未完成。
// 続いて68が出ると第4回で完成します。その後の番号を加えても最初の成立回は第4回です。
// 確認　横・縦・斜めを1本ずつ別々に試します。4マスだけでは未成立、同時に2本そろっても当選は1枚です。

// 手順6　申告と照合する（先に手順5。画面との接続は draw.js と card.js で行います）
// 入力は開始時に確定した参加カード・配置、対象回までの履歴、そのカードの確認報告です。
// gameId と cardId が一致し、その回の checkedDrawCount と判定結果が一緒に届いたか確かめます。
// 古い回・未来の回・別カードの報告は今回の確認に使えません。未応答は未確認として返します。
// 有効な報告も配置と履歴から手順5で再計算し、食い違いは理由を添えて draw.js に伝えます。
// 待機後に進行役自身が判定した場合は「代替照合済み」として返します。カード本人の応答とは分けます。
// 当選者をまとめるときはゲームとカードのIDで照合し、最初の成立回が早いグループから並べます。
// 確認　同じ回の2枚は通知の到着順にかかわらず同着。同じカードの再報告や複数列完成は1件のまま。
// ここまで試せたら storage.js の手順1へ。画面をリロードしても同じ結果を再現できるようにします。
