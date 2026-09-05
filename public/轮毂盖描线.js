// 描线只处理二维图案；预览和分色实体共用最后的闭合轮廓。
export function outlineDistance(mask, size, feature = 0) {
  const distance = new Float32Array(mask.length);
  const values = new Float64Array(size), result = new Float64Array(size);
  const sites = new Int32Array(size), bounds = new Float64Array(size + 1);
  const transform = () => {
    let last = 0;
    sites[0] = 0; bounds[0] = -Infinity; bounds[1] = Infinity;
    for (let q = 1; q < size; q += 1) {
      let crossing;
      do {
        const v = sites[last];
        crossing = ((values[q] + q * q) - (values[v] + v * v)) / (2 * (q - v));
        if (crossing > bounds[last]) break;
        last -= 1;
      } while (last >= 0);
      last += 1; sites[last] = q; bounds[last] = crossing; bounds[last + 1] = Infinity;
    }
    last = 0;
    for (let q = 0; q < size; q += 1) {
      while (bounds[last + 1] < q) last += 1;
      result[q] = (q - sites[last]) ** 2 + values[sites[last]];
    }
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) values[x] = mask[y * size + x] === feature ? 0 : 1e12;
    transform();
    for (let x = 0; x < size; x += 1) distance[y * size + x] = result[x];
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) values[y] = distance[y * size + x];
    transform();
    for (let y = 0; y < size; y += 1) {
      // 画布外也是背景，贴边黑色区域仍具有有限的内距。
      distance[y * size + x] = Math.sqrt(feature === 0 ? Math.min(result[y], (x + 1) ** 2, (size - x) ** 2, (y + 1) ** 2, (size - y) ** 2) : result[y]);
    }
  }
  return distance;
}

const neighbours = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
const simplePoints = new Uint8Array(256);
const neighbourCounts = new Uint8Array(256);
for (let code = 0; code < 256; code += 1) {
  let foreground = 0;
  neighbours.forEach(([x, y], bit) => { if (code & (1 << bit)) { foreground |= 1 << ((y + 1) * 3 + x + 1); neighbourCounts[code] += 1; } });
  const components = (bits, diagonal) => {
    let count = 0;
    while (bits) {
      const queue = [Math.clz32(bits & -bits) ^ 31];
      bits &= ~(1 << queue[0]); count += 1;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const i = queue[cursor], x = i % 3, y = Math.floor(i / 3);
        neighbours.forEach(([dx, dy]) => {
          if (!diagonal && dx && dy) return;
          const nx = x + dx, ny = y + dy, bit = 1 << (ny * 3 + nx);
          if (nx >= 0 && nx < 3 && ny >= 0 && ny < 3 && (bits & bit)) { bits &= ~bit; queue.push(ny * 3 + nx); }
        });
      }
    }
    return count;
  };
  const background = 511 ^ (foreground | 16);
  // 黑线八连通、白底四连通：改动边缘不能断线、合并独立细节或填掉小孔。
  simplePoints[code] = components(foreground, true) === 1 && components(background, false) === components(background | 16, false) ? 1 : 0;
}

function neighbourhood(mask, size, index) {
  const x = index % size, y = Math.floor(index / size);
  let code = 0;
  neighbours.forEach(([dx, dy], bit) => {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < size && ny >= 0 && ny < size && mask[ny * size + nx]) code |= 1 << bit;
  });
  return code;
}

export function adjustOutlineWeight(mask, size, percent, minimumWidth = 2) {
  if (percent === 100) return mask.slice();
  const inside = outlineDistance(mask, size);
  const foreground = [], localRadius = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) foreground.push(i);
  if (!foreground.length) return mask.slice();
  foreground.sort((a, b) => inside[b] - inside[a]);
  const radii = [];
  // 沿内距梯度估计每处笔画的厚度；只调整边缘，不用单像素骨架重画图案。
  for (const i of foreground) {
    const x = i % size, y = Math.floor(i / size);
    let next = i, gradient = 0;
    neighbours.forEach(([dx, dy]) => {
      const nx = x + dx, ny = y + dy, j = ny * size + nx;
      if (nx < 0 || nx >= size || ny < 0 || ny >= size) return;
      const slope = (inside[j] - inside[i]) / (dx && dy ? Math.SQRT2 : 1);
      if (slope > gradient) { gradient = slope; next = j; }
    });
    localRadius[i] = next === i ? Math.max(.5, inside[i] - .5) : localRadius[next];
    if (next === i) radii.push(localRadius[i]);
  }
  radii.sort((a, b) => a - b);
  const offset = radii[Math.floor(radii.length / 2)] * Math.abs(percent / 100 - 1);
  const shrinking = percent < 100;
  const distance = shrinking ? inside : outlineDistance(mask, size, 1);
  const candidates = [], corners = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    const localOffset = shrinking ? Math.max(0, localRadius[i] - Math.max(localRadius[i] * percent / 100, minimumWidth / 2)) : offset;
    if (Boolean(mask[i]) === shrinking && distance[i] <= localOffset + .5) {
      candidates.push(i); corners[i] = 8 - neighbourCounts[neighbourhood(mask, size, i)];
    }
  }
  candidates.sort((a, b) => distance[a] - distance[b] || corners[a] - corners[b] || a - b);
  const output = mask.slice();
  for (const i of candidates) {
    const code = neighbourhood(output, size, i);
    // 端点和独立小点不随收细消失；只剥离拓扑允许的边缘像素。
    if (simplePoints[code] && (!shrinking || neighbourCounts[code] > 1)) output[i] = shrinking ? 0 : 1;
  }
  return output;
}

export function detectOutline(pixels, size, requestedSource, sensitivity, smoothing = 0) {
  let luminance = new Float32Array(size * size);
  let light = 0, dark = 0, intermediate = 0, colored = 0;
  for (let i = 0; i < luminance.length; i += 1) {
    const offset = i * 4, alpha = pixels.data[offset + 3] / 255;
    const r = pixels.data[offset], g = pixels.data[offset + 1], b = pixels.data[offset + 2];
    const value = (r * .2126 + g * .7152 + b * .0722) * alpha + 255 * (1 - alpha);
    luminance[i] = value;
    if (value > 220) light += 1;
    else if (value < 100) dark += 1;
    else intermediate += 1;
    if (alpha > .5 && Math.max(r,g,b) - Math.min(r,g,b) > 35) colored += 1;
  }
  const count = luminance.length;
  const source = requestedSource === "auto"
    ? (light / count > .5 && dark / count < .4 && intermediate / count < .25 && colored / count < .08 ? "line" : "edge")
    : requestedSource;
  // 线稿默认不模糊；照片的轻微高斯预滤波抑制采样噪声。
  for (let pass = 0; pass < (source === "edge" ? 1 + smoothing : smoothing); pass += 1) {
    const next = luminance.slice();
    for (let y = 1; y < size - 1; y += 1) for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      next[i] = (luminance[i-size-1] + 2*luminance[i-size] + luminance[i-size+1] + 2*luminance[i-1] + 4*luminance[i] + 2*luminance[i+1] + luminance[i+size-1] + 2*luminance[i+size] + luminance[i+size+1]) / 16;
    }
    luminance = next;
  }
  const mask = new Uint8Array(count);
  if (source === "line") {
    const threshold = 80 + sensitivity * 1.45;
    for (let i = 0; i < count; i += 1) mask[i] = luminance[i] < threshold ? 1 : 0;
    return { mask, source };
  }
  const magnitude = new Float32Array(count), direction = new Uint8Array(count);
  for (let y = 1; y < size - 1; y += 1) for (let x = 1; x < size - 1; x += 1) {
    const i = y * size + x;
    const gx = -luminance[i-size-1] - 2*luminance[i-1] - luminance[i+size-1] + luminance[i-size+1] + 2*luminance[i+1] + luminance[i+size+1];
    const gy = -luminance[i-size-1] - 2*luminance[i-size] - luminance[i-size+1] + luminance[i+size-1] + 2*luminance[i+size] + luminance[i+size+1];
    magnitude[i] = Math.hypot(gx, gy);
    direction[i] = (Math.round(Math.atan2(gy, gx) / (Math.PI / 4)) + 4) % 4;
  }
  const high = 235 - sensitivity * 2.25, low = high * .4;
  const weak = new Uint8Array(count), queue = new Int32Array(count);
  const offsets = [1, size + 1, size, size - 1];
  let head = 0, tail = 0;
  for (let y = 1; y < size - 1; y += 1) for (let x = 1; x < size - 1; x += 1) {
    const i = y * size + x, step = offsets[direction[i]], value = magnitude[i];
    // 非极大值抑制先定位边缘；线宽只在边缘确定后施加。
    if (value < low || value < magnitude[i-step] || value <= magnitude[i+step]) continue;
    if (value >= high) { mask[i] = 1; queue[tail++] = i; }
    else weak[i] = 1;
  }
  while (head < tail) {
    const i = queue[head++], x = i % size, y = Math.floor(i / size);
    neighbours.forEach(([dx, dy]) => {
      const nx = x + dx, ny = y + dy, next = ny * size + nx;
      if (nx >= 0 && nx < size && ny >= 0 && ny < size && weak[next] && !mask[next]) { mask[next] = 1; queue[tail++] = next; }
    });
  }
  return { mask, source };
}

export function traceOutlineContours(mask, size, field = null, level = .5) {
  // Marching squares：同一个鞍点连接黑线，白底使用其补集，避免角点接触和分色裂缝。
  const cases = [[],[0,3],[1,0],[1,3],[2,1],[0,1,2,3],[2,0],[2,3],[3,2],[0,2],[3,0,1,2],[1,2],[3,1],[0,1],[3,0],[]];
  const links = new Map(), points = new Map(), stride = 2 * size + 3;
  const sample = (x, y) => x >= 0 && x < size && y >= 0 && y < size ? mask[y * size + x] : 0;
  for (let y = -1; y < size; y += 1) for (let x = -1; x < size; x += 1) {
    const code = sample(x,y) | (sample(x+1,y) << 1) | (sample(x+1,y+1) << 2) | (sample(x,y+1) << 3);
    const segments = cases[code];
    if (!segments.length) continue;
    const edges = [[x+.5,y+.5,x+1.5,y+.5],[x+1.5,y+.5,x+1.5,y+1.5],[x+.5,y+1.5,x+1.5,y+1.5],[x+.5,y+.5,x+.5,y+1.5]];
    const keys = edges.map(([x0,y0,x1,y1]) => (x0+x1+1) + (y0+y1+1) * stride);
    for (const edge of segments) {
      if (points.has(keys[edge])) continue;
      const [x0,y0,x1,y1] = edges[edge];
      let t = .5;
      if (field && x0 >= .5 && y0 >= .5 && x1 < size && y1 < size) {
        const a = field[Math.floor(y0)*size+Math.floor(x0)], b = field[Math.floor(y1)*size+Math.floor(x1)];
        if (a !== b) t = Math.max(.001, Math.min(.999, (level - a) / (b - a)));
      }
      points.set(keys[edge], [x0+(x1-x0)*t, y0+(y1-y0)*t]);
    }
    for (let j = 0; j < segments.length; j += 2) {
      const a = keys[segments[j]], b = keys[segments[j+1]];
      if (!links.has(a)) links.set(a, []);
      if (!links.has(b)) links.set(b, []);
      links.get(a).push(b); links.get(b).push(a);
    }
  }
  const contours = [], visited = new Set();
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const polygon = [];
    let current = start, previous = -1;
    do {
      polygon.push(points.get(current)); visited.add(current);
      const next = links.get(current).find((key) => key !== previous);
      previous = current; current = next;
    } while (current !== start);
    contours.push(polygon);
  }
  return contours;
}
