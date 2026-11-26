/**
 * qrcode.js — 零外部依賴、100% 離線本機運算之 ISO/IEC 18004 標準 QR Code SVG 產生器
 * 支援 UTF-8 網址與文字（Version 1-L ~ 9-L，最高 230 bytes），完全符合嚴格 CSP (script-src 'self')，不傳送網址至任何外部服務。
 */
(function () {
  "use strict";

  // Version 1~9 (EC Level L = 01): [totalDataCodewords, ecCodewordsPerBlock, numBlocks, alignmentCenters]
  const VERSION_SPECS = [
    null,
    [19, 7, 1, []],
    [34, 10, 1, [6, 18]],
    [55, 15, 1, [6, 22]],
    [80, 20, 1, [6, 26]],
    [108, 26, 1, [6, 30]],
    [136, 18, 2, [6, 34]],
    [156, 20, 2, [6, 22, 38]],
    [194, 24, 2, [6, 24, 42]],
    [232, 30, 2, [6, 26, 46]]
  ];

  // GF(256) 對數與反對數表（本原多項式 0x11D）
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      GF_EXP[i] = GF_EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) {
      const next = new Uint8Array(poly.length + 1);
      const root = GF_EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], root);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(dataBytes, ecLen) {
    const gen = rsGeneratorPoly(ecLen);
    const rem = new Uint8Array(ecLen);
    for (let i = 0; i < dataBytes.length; i++) {
      const factor = dataBytes[i] ^ rem[0];
      for (let j = 0; j < ecLen - 1; j++) {
        rem[j] = rem[j + 1] ^ gfMul(gen[j + 1], factor);
      }
      rem[ecLen - 1] = gfMul(gen[ecLen], factor);
    }
    return rem;
  }

  function buildCodewords(utf8Bytes) {
    let ver = 1;
    while (ver <= 9) {
      const maxData = VERSION_SPECS[ver][0];
      const headerBits = 4 + (ver <= 9 ? 8 : 16);
      if (utf8Bytes.length * 8 + headerBits <= maxData * 8) break;
      ver++;
    }
    if (ver > 9) {
      throw new Error("QR Code 內容長度超過上限");
    }

    const [totalDataCw, ecPerBlock, numBlocks] = VERSION_SPECS[ver];
    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };

    // Byte mode indicator = 0100
    pushBits(0b0100, 4);
    pushBits(utf8Bytes.length, 8);
    for (let i = 0; i < utf8Bytes.length; i++) {
      pushBits(utf8Bytes[i], 8);
    }

    const maxBits = totalDataCw * 8;
    const term = Math.min(4, maxBits - bits.length);
    for (let i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const dataCw = new Uint8Array(totalDataCw);
    for (let i = 0; i < bits.length / 8; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
      dataCw[i] = b;
    }
    const pads = [0xec, 0x11];
    for (let i = bits.length / 8, p = 0; i < totalDataCw; i++, p ^= 1) {
      dataCw[i] = pads[p];
    }

    const blockDataLen = totalDataCw / numBlocks;
    const dataBlocks = [];
    const ecBlocks = [];
    for (let b = 0; b < numBlocks; b++) {
      const slice = dataCw.slice(b * blockDataLen, (b + 1) * blockDataLen);
      dataBlocks.push(slice);
      ecBlocks.push(rsEncode(slice, ecPerBlock));
    }

    const interleaved = [];
    for (let i = 0; i < blockDataLen; i++) {
      for (let b = 0; b < numBlocks; b++) interleaved.push(dataBlocks[b][i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (let b = 0; b < numBlocks; b++) interleaved.push(ecBlocks[b][i]);
    }

    return { ver, codewords: interleaved };
  }

  function formatInfoBits(ecIndicator, maskPattern) {
    const data = ((ecIndicator << 3) | maskPattern) & 0x1f;
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) {
      if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    }
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionInfoBits(ver) {
    let rem = ver << 12;
    for (let i = 17; i >= 12; i--) {
      if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
    }
    return (ver << 12) | rem;
  }

  function buildMatrix(text) {
    const utf8 = new TextEncoder().encode(String(text || ""));
    const { ver, codewords } = buildCodewords(utf8);
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

    const setFunc = (r, c, dark) => {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      modules[r][c] = dark ? 1 : 0;
      isFunc[r][c] = 1;
    };

    const drawFinder = (topR, leftC) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = topR + dr;
          const c = leftC + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFunc(r, c, inOuter && (onBorder || inCenter));
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    const aligns = VERSION_SPECS[ver][3];
    for (let i = 0; i < aligns.length; i++) {
      for (let j = 0; j < aligns.length; j++) {
        const cr = aligns[i];
        const cc = aligns[j];
        if (
          (cr === 6 && cc === 6) ||
          (cr === 6 && cc === size - 7) ||
          (cr === size - 7 && cc === 6)
        ) {
          continue;
        }
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunc(cr + dr, cc + dc, dark);
          }
        }
      }
    }

    // Dark module & reserve format areas
    setFunc(4 * ver + 9, 8, true);
    for (let i = 0; i <= 8; i++) {
      if (!isFunc[8][i]) setFunc(8, i, false);
      if (!isFunc[i][8]) setFunc(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      if (!isFunc[8][size - 1 - i]) setFunc(8, size - 1 - i, false);
      if (!isFunc[size - 1 - i][8]) setFunc(size - 1 - i, 8, false);
    }

    // Version >= 7 info blocks
    if (ver >= 7) {
      const vBits = versionInfoBits(ver);
      for (let i = 0; i < 18; i++) {
        const bit = ((vBits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunc(b, a, bit);
        setFunc(a, b, bit);
      }
    }

    // Zig-zag data bits placement
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const r = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!isFunc[r][c]) {
            let dark = false;
            if (bitIdx < totalBits) {
              dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
              bitIdx++;
            }
            modules[r][c] = dark ? 1 : 0;
          }
        }
      }
      upward = !upward;
    }

    // Choose lowest-penalty mask among 0..7
    const maskFns = [
      (r, c) => (r + c) % 2 === 0,
      (r, c) => r % 2 === 0,
      (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    ];

    const writeFormatBits = (grid, mask) => {
      // EC Level L = 0b01 (ISO/IEC 18004 Figure 25: bit 14 MSB -> bit 0 LSB)
      const bits = formatInfoBits(0b01, mask);
      const topLeftCoords = [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
        [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
      ];
      for (let i = 0; i < 15; i++) {
        const bit = (bits >>> (14 - i)) & 1;
        const [r, c] = topLeftCoords[i];
        grid[r][c] = bit;
      }
      for (let i = 0; i < 7; i++) {
        grid[size - 1 - i][8] = (bits >>> (14 - i)) & 1;
      }
      grid[size - 8][8] = 1; // Dark module
      for (let i = 7; i < 15; i++) {
        grid[8][size - 15 + i] = (bits >>> (14 - i)) & 1;
      }
    };

    const scorePenalty = (grid) => {
      let score = 0;
      for (let r = 0; r < size; r++) {
        let run = 1;
        for (let c = 1; c < size; c++) {
          if (grid[r][c] === grid[r][c - 1]) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else run = 1;
        }
      }
      for (let c = 0; c < size; c++) {
        let run = 1;
        for (let r = 1; r < size; r++) {
          if (grid[r][c] === grid[r - 1][c]) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else run = 1;
        }
      }
      return score;
    };

    let bestGrid = null;
    let bestPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      const copy = modules.map((row) => Uint8Array.from(row));
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!isFunc[r][c] && maskFns[m](r, c)) {
            copy[r][c] ^= 1;
          }
        }
      }
      writeFormatBits(copy, m);
      const p = scorePenalty(copy);
      if (p < bestPenalty) {
        bestPenalty = p;
        bestGrid = copy;
      }
    }

    return { size, grid: bestGrid };
  }

  function toSvg(text, opts) {
    const options = opts || {};
    const margin = options.margin ?? 4;
    const fg = options.fg || "#1d1c19";
    const bg = options.bg || "#ffffff";
    const { size, grid } = buildMatrix(text);
    const total = size + margin * 2;
    const paths = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (grid[r][c]) {
          paths.push(`M${c + margin},${r + margin}h1v1h-1z`);
        }
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR Code">` +
      `<rect width="${total}" height="${total}" fill="${bg}"/>` +
      `<path d="${paths.join("")}" fill="${fg}"/>` +
      `</svg>`
    );
  }

  window.SimpleQR = { toSvg, buildMatrix };
})();
