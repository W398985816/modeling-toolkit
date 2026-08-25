import Module from "./vendor/manifold/manifold.js";

const wasmUrl = new URL("./vendor/manifold/manifold.wasm", import.meta.url);
let kernelPromise;

export function initializeGeometryKernel() {
  if (!kernelPromise) {
    kernelPromise = Module({
      locateFile: () => typeof window === "undefined" ? wasmUrl.pathname : wasmUrl.href
    }).then((wasm) => {
      wasm.setup();
      return wasm;
    });
  }
  return kernelPromise;
}

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const degrees = (radians) => radians * 180 / Math.PI;

export function deriveStructure(raw, custom = null) {
  const strength = {
    easy: { thicknessDivisor:13, thicknessMin:1.6, thicknessMax:2.2, contactRatio:.55, contactMin:10, contactMax:16, rootRatio:.18, rootMin:3, rootMax:5, flareRatio:.6 },
    balanced: { thicknessDivisor:11.5, thicknessMin:1.7, thicknessMax:2.5, contactRatio:.62, contactMin:11, contactMax:18, rootRatio:.22, rootMin:3.5, rootMax:6, flareRatio:.75 },
    reinforced: { thicknessDivisor:10, thicknessMin:1.8, thicknessMax:2.8, contactRatio:.7, contactMin:12, contactMax:20, rootRatio:.25, rootMin:4, rootMax:7, flareRatio:.9 }
  }[raw.strengthPreset];
  const fit = {
    tight: { sideClearance:.25, hookReach:1 },
    standard: { sideClearance:.35, hookReach:.8 },
    loose: { sideClearance:.45, hookReach:.65 }
  }[raw.fitPreset];
  const automatic = {
    ...raw,
    coverThickness:clamp(raw.coverDiameter * .012, 2, 3.2),
    outerRingWidth:clamp(raw.coverDiameter * .04, 6, 14),
    contactLength:clamp(raw.spokeBackDepth * strength.contactRatio, strength.contactMin, strength.contactMax),
    legThickness:clamp(raw.spokeBackDepth / strength.thicknessDivisor, strength.thicknessMin, strength.thicknessMax),
    rootHeight:clamp(raw.spokeBackDepth * strength.rootRatio, strength.rootMin, strength.rootMax),
    sideClearance:fit.sideClearance,
    hookReach:fit.hookReach,
    hookHeight:Math.max(1.4, fit.hookReach + .6),
    insertionRampHeight:fit.hookReach + fit.sideClearance,
    releaseTabs:raw.releaseTabs ?? true,
    minWall:1.2,
    nozzleWidth:.4,
    layerHeight:.2
  };
  const result = { ...automatic, ...(custom || {}) };
  result.rootFlare = clamp(result.legThickness * strength.flareRatio, 1, 2.6);
  result.tipThickness = Math.max(1.2, result.legThickness * .72);
  result.tipWidth = Math.max(8, result.contactLength * .82);
  result.releaseTabLength = result.releaseTabs ? 3 : 0;
  result.flexPerJaw = Math.max(0, result.hookReach);
  result.freeLength = Math.max(2, raw.spokeBackDepth - result.rootHeight);
  result.insertionAngle = Math.atan2(result.hookReach + result.sideClearance, result.insertionRampHeight) * 180 / Math.PI;
  result.retentionArea = result.hookReach * result.tipWidth;
  // 仍使用等截面悬臂公式，渐变爪的实际应变会更低，因此这是保守筛查值。
  result.estimatedStrain = 1.5 * result.legThickness * result.flexPerJaw / (result.freeLength * result.freeLength) * 100;
  return result;
}

export function clipMetrics(p, activeIndices) {
  const pairWidth = p.openingWidth + 2 * p.hookReach;
  return {
    coverRadius:p.coverDiameter / 2,
    pairWidth,
    jawOuterSpan:p.openingWidth - p.sideClearance * 2,
    centerGap:p.openingWidth - 2 * (p.sideClearance + p.tipThickness),
    hookSpan:pairWidth,
    availableArc:2 * Math.PI * p.clipRadius / p.clipCount - pairWidth,
    enabled:activeIndices.length,
    flexPerJaw:p.flexPerJaw
  };
}

export function validateDesign(p, activeIndices, patternReport = null) {
  const m = clipMetrics(p, activeIndices);
  const errors = [];
  const warnings = [];
  if (m.enabled < 3) errors.push("至少需要保留 3 组双爪卡扣");
  if (p.clipRadius - p.contactLength / 2 - p.rootFlare < 3) errors.push("卡扣安装半径过小，加强根座已越过盖板中心");
  if (p.clipRadius + p.contactLength / 2 + p.rootFlare + 2 > m.coverRadius) errors.push("卡扣加强根座超出盖板外缘");
  if (m.availableArc < 3) errors.push("相邻卡爪或拆卸拨片间距小于 3 mm");
  if (p.spokeBackDepth <= p.rootHeight + 2) errors.push("卡扣总深度过短，无法保留根部渐变区和弹性直段");
  if (p.contactLength < 8) errors.push("卡爪径向宽度不能小于 8 mm");
  if (p.legThickness < 1.2) errors.push("卡爪根部厚度不能小于 1.2 mm");
  if (p.tipThickness + 1e-6 < p.nozzleWidth * 3) errors.push("卡爪末端不足 3 道喷嘴线宽");
  if (p.sideClearance < .1) errors.push("单侧装配间隙不能小于 0.1 mm");
  if (m.centerGap < Math.max(2, p.releaseTabLength * 2 + 1)) errors.push("轮辐开口过窄，无法容纳双爪弹性间隙和拆卸拨片");
  if (p.hookReach < .3) errors.push("每侧倒钩外伸量不能小于 0.3 mm");
  if (p.hookReach > p.legThickness * 1.25) errors.push("倒钩外伸量相对爪片厚度过大，根部应力过高");
  if (p.insertionRampHeight < p.hookReach + p.sideClearance) errors.push("导入斜面过陡；高度应不小于装配间隙与倒钩外伸量之和");
  if (p.insertionRampHeight > p.hookHeight) errors.push("导入斜面高度不能超过倒钩轴向高度");
  if (p.retentionArea < 6) warnings.push("单爪承力面积偏小，建议增加倒钩外伸量或爪片径向宽度");
  if (p.estimatedStrain > 3) errors.push(`预计卡爪应变 ${p.estimatedStrain.toFixed(1)}%，超过 PETG 设计筛查上限 3%`);
  else if (p.estimatedStrain > 2) warnings.push(`预计卡爪应变 ${p.estimatedStrain.toFixed(1)}%，建议先打印单组试装`);
  if (p.spokeBackDepth / p.legThickness > 24) errors.push("卡爪长宽比过大，渐变结构仍不足以控制摆动");
  else if (p.spokeBackDepth / p.legThickness > 16) warnings.push("长卡爪较柔，请检查振动摆动和疲劳强度");
  if (m.enabled > 8) warnings.push("启用卡扣较多，拆装阻力可能明显增加");
  const activeAngles = activeIndices.map((index) => (p.startAngle + Math.PI * 2 * index / p.clipCount + Math.PI * 4) % (Math.PI * 2)).sort((a, b) => a - b);
  if (activeAngles.length >= 3) {
    const gaps = activeAngles.map((angle, index) => ((activeAngles[(index + 1) % activeAngles.length] - angle + Math.PI * 2) % (Math.PI * 2)));
    if (Math.max(...gaps) > Math.PI * .9) warnings.push("卡扣分布明显不均，建议检查偏载和振动松脱风险");
  }
  if (patternReport?.wallAdjusted) warnings.push("已自动合并或移除小于最小壁厚的图案细节");
  if (patternReport?.islandsRemoved) warnings.push(`已移除 ${patternReport.islandsRemoved} 个未连接主体的实体孤岛`);
  return { valid:errors.length === 0, errors, warnings };
}

export function validateTrialClip(p) {
  const errors = [];
  if (p.spokeBackDepth <= p.rootHeight + 2) errors.push("卡扣总深度过短");
  if (p.contactLength < 8 || p.legThickness < 1.2 || p.sideClearance < .1) errors.push("卡爪基础尺寸过小");
  if (p.openingWidth - 2 * (p.sideClearance + p.tipThickness) < Math.max(2, p.releaseTabLength * 2 + 1)) errors.push("轮辐开口无法容纳双爪和拆卸拨片");
  if (p.hookReach < .3 || p.hookReach > p.legThickness * 1.25) errors.push("倒钩外伸量无效");
  if (p.insertionRampHeight < p.hookReach + p.sideClearance || p.insertionRampHeight > p.hookHeight) errors.push("倒钩导入斜面尺寸无效");
  if (p.estimatedStrain > 3) errors.push("预计卡爪应变超过 3%");
  return { valid:errors.length === 0, errors };
}

const dispose = (...objects) => objects.flat().forEach((object) => {
  if (object && typeof object.delete === "function") object.delete();
});

function transformedBox(Manifold, size, origin, angle = 0) {
  const cube = Manifold.cube(size);
  const moved = cube.translate(origin);
  cube.delete();
  if (!angle) return moved;
  const rotated = moved.rotate([0, 0, angle]);
  moved.delete();
  return rotated;
}

function localPoint(angle, radial, tangential, z) {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return [cosine * radial - sine * tangential, sine * radial + cosine * tangential, z];
}

function manifoldFromProfilePrism(wasm, angle, radial0, radial1, profile) {
  const { Manifold, CrossSection } = wasm;
  const section = CrossSection.ofPolygons([profile.map((point) => [point.t, point.z])], "Positive");
  const prism = Manifold.extrude(section, radial1 - radial0);
  section.delete();
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const transformed = prism.transform([
    -sine, cosine, 0, 0,
    0, 0, 1, 0,
    cosine, sine, 0, 0,
    cosine * radial0, sine * radial0, 0, 1
  ]);
  prism.delete();
  return transformed;
}

function unionAndDispose(Manifold, solids) {
  const filtered = solids.filter(Boolean);
  if (!filtered.length) return Manifold.cube([.01, .01, .01]);
  if (filtered.length === 1) return filtered[0];
  const result = Manifold.union(filtered);
  dispose(filtered);
  return result;
}

function hullPair(Manifold, first, second) {
  const result = Manifold.hull([first, second]);
  dispose(first, second);
  return result;
}

function clawSection(Manifold, p, angleDegrees, side, radialWidth, thickness, z, zThickness, inwardExtra = 0) {
  const edge = p.openingWidth / 2;
  const outerFace = side > 0 ? edge - p.sideClearance : -edge + p.sideClearance;
  const radial0 = p.clipRadius - radialWidth / 2;
  // 两爪都位于同一个轮辐开口内；加宽只朝开口中心延伸，避免根座撞到开口边缘。
  const tangent0 = side > 0 ? outerFace - thickness - inwardExtra : outerFace;
  const tangent1 = side > 0 ? outerFace : outerFace + thickness + inwardExtra;
  return transformedBox(
    Manifold,
    [radialWidth, tangent1 - tangent0, zThickness],
    [radial0, tangent0, z],
    angleDegrees
  );
}

function buildTaperedArm(wasm, p, angle, side) {
  const { Manifold } = wasm;
  const angleDegrees = degrees(angle);
  const sectionDepth = Math.min(.36, p.layerHeight * 2);
  const root = clawSection(Manifold, p, angleDegrees, side, p.contactLength + 2 * p.rootFlare, p.legThickness, -.18, sectionDepth, p.rootFlare);
  const rootEnd = clawSection(Manifold, p, angleDegrees, side, p.contactLength, p.legThickness, -p.rootHeight, sectionDepth);
  const tip = clawSection(Manifold, p, angleDegrees, side, p.tipWidth, p.tipThickness, -p.spokeBackDepth - sectionDepth / 2, sectionDepth);
  const rootTaper = hullPair(Manifold, root, rootEnd);
  const freeTaper = hullPair(Manifold, clawSection(Manifold, p, angleDegrees, side, p.contactLength, p.legThickness, -p.rootHeight, sectionDepth), tip);
  return unionAndDispose(Manifold, [rootTaper, freeTaper]);
}

function buildHook(wasm, p, angle, side) {
  const { Manifold } = wasm;
  const edge = p.openingWidth / 2;
  const armOuter = edge - p.sideClearance;
  const armInner = armOuter - p.tipThickness;
  const hookOuter = edge + p.hookReach;
  const backFace = -p.spokeBackDepth;
  const leadingFace = backFace - p.hookHeight;
  const profile = [
    { t:armInner, z:leadingFace },
    { t:armOuter, z:leadingFace },
    { t:hookOuter, z:leadingFace + p.insertionRampHeight },
    { t:hookOuter, z:backFace },
    { t:armInner, z:backFace }
  ];
  const orientedProfile = side > 0 ? profile : profile.map((point) => ({ t:-point.t, z:point.z })).reverse();
  const radial0 = p.clipRadius - p.tipWidth / 2;
  const radial1 = p.clipRadius + p.tipWidth / 2;
  const parts = [manifoldFromProfilePrism(wasm, angle, radial0, radial1, orientedProfile)];
  if (p.releaseTabs) {
    const angleDegrees = degrees(angle);
    const tabWidth = Math.max(7, p.tipWidth * .58);
    const tabZ = -p.spokeBackDepth - p.hookHeight + .2;
    const near = clawSection(Manifold, p, angleDegrees, side, tabWidth, p.tipThickness, tabZ, 1, .25);
    const far = clawSection(Manifold, p, angleDegrees, side, tabWidth, p.tipThickness, tabZ + .15, .7, p.releaseTabLength);
    parts.push(hullPair(Manifold, near, far));
  }
  return unionAndDispose(Manifold, parts);
}

function buildClipSolids(wasm, p, activeIndices) {
  const { Manifold } = wasm;
  const groups = activeIndices.map((index) => {
    const angle = p.startAngle + Math.PI * 2 * index / p.clipCount;
    const parts = [];
    [-1, 1].forEach((side) => {
      parts.push(buildTaperedArm(wasm, p, angle, side));
      parts.push(buildHook(wasm, p, angle, side));
    });
    return unionAndDispose(Manifold, parts);
  });
  return unionAndDispose(Manifold, groups);
}

function rootProtection(wasm, p, activeIndices) {
  const { CrossSection } = wasm;
  const radialWidth = p.contactLength + 2 * p.rootFlare + 4;
  const tangentWidth = p.openingWidth + p.minWall * 2;
  const rootInner = p.clipRadius - radialWidth / 2;
  const rootOuter = p.clipRadius + radialWidth / 2;
  const ringInner = p.coverDiameter / 2 - p.outerRingWidth;
  const bridgeOuter = Math.max(rootOuter, ringInner + p.minWall);
  const bridgeHalfWidth = Math.max(p.minWall * 1.5, Math.min(tangentWidth * .32, 5));
  const sections = activeIndices.map((index) => {
    const polygon = [[
      [rootInner, -tangentWidth / 2],
      [rootOuter, -tangentWidth / 2],
      [bridgeOuter, -bridgeHalfWidth],
      [bridgeOuter, bridgeHalfWidth],
      [rootOuter, tangentWidth / 2],
      [rootInner, tangentWidth / 2]
    ]];
    const section = CrossSection.ofPolygons(polygon, "Positive");
    const rotated = section.rotate(degrees(p.startAngle + Math.PI * 2 * index / p.clipCount));
    section.delete();
    return rotated;
  });
  return sections.length ? CrossSection.union(sections) : CrossSection.circle(1, 24);
}

function defaultPattern(wasm, patternRadius) {
  const { CrossSection } = wasm;
  const slots = [];
  const radial0 = patternRadius * .28;
  const radial1 = patternRadius * .84;
  for (let index = 0; index < 10; index += 1) {
    const polygon = [[radial0, -patternRadius * .045], [radial1, -patternRadius * .105], [radial1, patternRadius * .105], [radial0, patternRadius * .045]];
    const section = new CrossSection([polygon], "Positive");
    const roundedIn = section.offset(-1.3, "Round", 2, 12);
    section.delete();
    const rounded = roundedIn.offset(1.3, "Round", 2, 12);
    roundedIn.delete();
    const rotated = rounded.rotate(index * 36);
    rounded.delete();
    slots.push(rotated);
  }
  const result = CrossSection.union(slots);
  dispose(slots);
  return result;
}

function maskRectangles(mask, patternRadius) {
  const { size, data } = mask;
  const rectangles = [];
  const scale = patternRadius * 2 / size;
  for (let row = 0; row < size; row += 1) {
    let start = -1;
    for (let column = 0; column <= size; column += 1) {
      const filled = column < size && data[row * size + column] === 1;
      if (filled && start < 0) start = column;
      if (!filled && start >= 0) {
        const x0 = -patternRadius + start * scale;
        const x1 = -patternRadius + column * scale;
        const y1 = patternRadius - row * scale;
        const y0 = y1 - scale;
        rectangles.push([[x0,y0],[x1,y0],[x1,y1],[x0,y1]]);
        start = -1;
      }
    }
  }
  return rectangles;
}

function vectorPattern(wasm, p, mask) {
  const { CrossSection } = wasm;
  const patternRadius = Math.max(4, p.coverDiameter / 2 - p.outerRingWidth);
  let pattern;
  if (!mask) {
    pattern = defaultPattern(wasm, patternRadius);
  } else {
    const rectangles = maskRectangles(mask, patternRadius);
    if (!rectangles.length) return CrossSection.circle(.01, 8);
    const raw = new CrossSection(rectangles, "Positive");
    pattern = raw.simplify(Math.max(.04, patternRadius / 2400));
    raw.delete();
  }
  const scale = clamp(p.patternScale ?? 1, .3, 1);
  const scaled = pattern.scale(scale);
  pattern.delete();
  const smoothing = mask ? clamp(Math.round(p.patternSmoothing ?? 0), 0, 8) : 0;
  if (!smoothing) return scaled;
  const pixelSize = patternRadius * 2 / mask.size * scale;
  const rounding = Math.min(p.minWall * .55, pixelSize * smoothing * .45);
  const closedOut = scaled.offset(rounding, "Round", 2, 16);
  scaled.delete();
  const closed = closedOut.offset(-rounding, "Round", 2, 16);
  closedOut.delete();
  const openedIn = closed.offset(-rounding, "Round", 2, 16);
  closed.delete();
  const opened = openedIn.offset(rounding, "Round", 2, 16);
  openedIn.delete();
  const result = opened.simplify(Math.max(.035, pixelSize * .12));
  opened.delete();
  return result;
}

function buildCoverSection(wasm, p, activeIndices, mask) {
  const { CrossSection } = wasm;
  const radius = p.coverDiameter / 2;
  const segments = clamp(Math.ceil(Math.PI * 2 * radius / 1.5), 160, 420);
  const outer = CrossSection.circle(radius, segments);
  const inner = CrossSection.circle(Math.max(2, radius - p.outerRingWidth), segments);
  const ring = outer.subtract(inner);
  const protection = rootProtection(wasm, p, activeIndices);
  const protectionGuard = protection.offset(p.minWall / 2, "Round", 2, 12);
  const anchors = CrossSection.union([ring, protection]);
  const rawPattern = vectorPattern(wasm, p, mask);
  const clippedPattern = rawPattern.intersect(inner);
  rawPattern.delete();
  const patternWithoutRoots = clippedPattern.subtract(protectionGuard);
  clippedPattern.delete();
  const report = { wallAdjusted:false, islandsRemoved:0, contourCount:0 };
  let bodySection;
  let reliefSection = null;
  if (p.mode === "cut") {
    const expandedPattern = patternWithoutRoots.offset(p.minWall / 2, "Round", 2, 12);
    const closedPattern = expandedPattern.offset(-p.minWall / 2, "Round", 2, 12);
    expandedPattern.delete();
    const clippedSafePattern = closedPattern.intersect(inner);
    closedPattern.delete();
    const safePattern = clippedSafePattern.subtract(protectionGuard);
    clippedSafePattern.delete();
    report.wallAdjusted = Math.abs(patternWithoutRoots.area() - safePattern.area()) > p.minWall * p.minWall * .25;
    const combined = outer.subtract(safePattern);
    safePattern.delete();
    const components = combined.decompose();
    combined.delete();
    const kept = [];
    components.forEach((component) => {
      const contact = component.intersect(anchors);
      const connected = Math.abs(contact.area()) > .01;
      contact.delete();
      if (connected) kept.push(component);
      else {
        report.islandsRemoved += 1;
        component.delete();
      }
    });
    if (!kept.length) throw new Error("图案没有留下与外圈连接的盖板实体");
    bodySection = kept.length === 1 ? kept[0] : CrossSection.union(kept);
    if (kept.length > 1) dispose(kept);
  } else {
    bodySection = outer;
    reliefSection = patternWithoutRoots;
  }
  const contourSource = p.mode === "cut" ? bodySection : reliefSection;
  report.contourCount = contourSource ? contourSource.toPolygons().reduce((sum, polygon) => sum + polygon.length, 0) : 0;
  if (p.mode === "cut") outer.delete();
  dispose(inner, ring, protection, protectionGuard, anchors);
  if (p.mode === "cut") patternWithoutRoots.delete();
  return { bodySection, reliefSection, report };
}

function verifySolid(solid) {
  const status = solid.status();
  if (status !== "NoError") throw new Error(`流形内核返回 ${status}`);
  const parts = solid.decompose();
  const componentCount = parts.length;
  dispose(parts);
  if (componentCount !== 1) throw new Error(`模型包含 ${componentCount} 个独立实体`);
  const mesh = solid.getMesh();
  if (!mesh.triVerts.length || solid.volume() <= 0) throw new Error("模型体积无效");
  const indexedEdges = new Map();
  const geometricEdges = new Map();
  const coordinateKey = (vertex) => {
    const offset = vertex * mesh.numProp;
    return `${mesh.vertProperties[offset]},${mesh.vertProperties[offset + 1]},${mesh.vertProperties[offset + 2]}`;
  };
  for (let index = 0; index < mesh.triVerts.length; index += 3) {
    const triangle = [mesh.triVerts[index], mesh.triVerts[index + 1], mesh.triVerts[index + 2]];
    for (let edge = 0; edge < 3; edge += 1) {
      const a = triangle[edge], b = triangle[(edge + 1) % 3];
      const indexedKey = a < b ? `${a}:${b}` : `${b}:${a}`;
      indexedEdges.set(indexedKey, (indexedEdges.get(indexedKey) || 0) + 1);
      const pointA = coordinateKey(a), pointB = coordinateKey(b);
      const geometricKey = pointA < pointB ? `${pointA}|${pointB}` : `${pointB}|${pointA}`;
      geometricEdges.set(geometricKey, (geometricEdges.get(geometricKey) || 0) + 1);
    }
  }
  const indexedInvalidEdges = [...indexedEdges.values()].filter((count) => count !== 2).length;
  const geometricInvalidEdges = [...geometricEdges.values()].filter((count) => count !== 2).length;
  const invalidEdges = indexedInvalidEdges + geometricInvalidEdges;
  if (invalidEdges) throw new Error(`模型存在 ${invalidEdges} 条非流形边`);
  return {
    status,
    componentCount,
    invalidEdges,
    triangleCount:mesh.triVerts.length / 3,
    vertexCount:mesh.vertProperties.length / mesh.numProp,
    genus:solid.genus(),
    volume:solid.volume(),
    bounds:solid.boundingBox(),
    mesh
  };
}

function meshTriangles(mesh, color = [0.93, .35, .16, 1]) {
  const triangles = [];
  const point = (index) => {
    const offset = index * mesh.numProp;
    return { x:mesh.vertProperties[offset], y:mesh.vertProperties[offset + 1], z:mesh.vertProperties[offset + 2] };
  };
  for (let index = 0; index < mesh.triVerts.length; index += 3) {
    triangles.push({
      a:point(mesh.triVerts[index]),
      b:point(mesh.triVerts[index + 1]),
      c:point(mesh.triVerts[index + 2]),
      color
    });
  }
  return triangles;
}

function indexedMesh(mesh) {
  const vertices = [];
  for (let index = 0; index < mesh.vertProperties.length; index += mesh.numProp) {
    vertices.push([mesh.vertProperties[index], mesh.vertProperties[index + 1], mesh.vertProperties[index + 2]]);
  }
  const triangles = [];
  for (let index = 0; index < mesh.triVerts.length; index += 3) {
    triangles.push([mesh.triVerts[index], mesh.triVerts[index + 1], mesh.triVerts[index + 2]]);
  }
  return { vertices, triangles };
}

function referenceTriangles(p, activeIndices) {
  const triangles = [];
  const addBox = (angle, radial0, radial1, tangent0, tangent1, z0, z1, color) => {
    const vertices = [
      localPoint(angle, radial0, tangent0, z0), localPoint(angle, radial1, tangent0, z0),
      localPoint(angle, radial1, tangent1, z0), localPoint(angle, radial0, tangent1, z0),
      localPoint(angle, radial0, tangent0, z1), localPoint(angle, radial1, tangent0, z1),
      localPoint(angle, radial1, tangent1, z1), localPoint(angle, radial0, tangent1, z1)
    ].map(([x,y,z]) => ({ x,y,z }));
    [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
      .forEach(([a,b,c]) => triangles.push({ a:vertices[a], b:vertices[b], c:vertices[c], color }));
  };
  const radialLength = p.contactLength * 1.9;
  const edgeWidth = Math.max(5, p.legThickness + p.hookReach + 3);
  activeIndices.forEach((index) => {
    const angle = p.startAngle + Math.PI * 2 * index / p.clipCount;
    const halfOpening = p.openingWidth / 2;
    addBox(angle, p.clipRadius-radialLength/2, p.clipRadius+radialLength/2, -halfOpening-edgeWidth, -halfOpening, -p.spokeBackDepth, 0, [.10,.44,.42,.18]);
    addBox(angle, p.clipRadius-radialLength/2, p.clipRadius+radialLength/2, halfOpening, halfOpening+edgeWidth, -p.spokeBackDepth, 0, [.10,.44,.42,.18]);
    addBox(angle, p.clipRadius-radialLength/2, p.clipRadius+radialLength/2, -halfOpening-edgeWidth-1, -halfOpening, -p.spokeBackDepth-.35, -p.spokeBackDepth, [.08,.30,.29,.28]);
    addBox(angle, p.clipRadius-radialLength/2, p.clipRadius+radialLength/2, halfOpening, halfOpening+edgeWidth+1, -p.spokeBackDepth-.35, -p.spokeBackDepth, [.08,.30,.29,.28]);
  });
  return triangles;
}

export async function buildHubcapGeometry(p, activeIndices, mask) {
  const wasm = await initializeGeometryKernel();
  const { Manifold } = wasm;
  const { bodySection, reliefSection, report } = buildCoverSection(wasm, p, activeIndices, mask);
  let cover = bodySection.extrude(p.coverThickness);
  bodySection.delete();
  if (reliefSection) {
    const reliefOverlap = Math.min(.1, p.coverThickness * .05);
    const reliefBase = reliefSection.extrude(p.reliefHeight + reliefOverlap);
    const relief = reliefBase.translate([0,0,p.coverThickness - reliefOverlap]);
    reliefBase.delete();
    reliefSection.delete();
    const united = cover.add(relief);
    dispose(cover, relief);
    cover = united;
  }
  const clips = buildClipSolids(wasm, p, activeIndices);
  const joined = cover.add(clips);
  dispose(cover, clips);
  const original = joined.asOriginal();
  joined.delete();
  // 折叠布尔运行段的共面接缝，保证 STL 按坐标焊接后仍为二流形。
  const solid = original.simplify(.001);
  original.delete();
  const verification = verifySolid(solid);
  const bodyTriangles = meshTriangles(verification.mesh);
  const exportMesh = indexedMesh(verification.mesh);
  solid.delete();
  return {
    bodyTriangles,
    exportMesh,
    referenceTriangles:referenceTriangles(p, activeIndices),
    report,
    verification:{ ...verification, mesh:undefined }
  };
}

export async function buildTrialClipGeometry(p) {
  const wasm = await initializeGeometryKernel();
  const { Manifold } = wasm;
  const baseRadius = trialBaseRadius(p);
  const base = Manifold.cylinder(p.coverThickness, baseRadius, baseRadius, 120);
  const clips = buildClipSolids(wasm, { ...p, clipRadius:0, clipCount:1, startAngle:0 }, [0]);
  const joined = base.add(clips);
  dispose(base, clips);
  const scaled = joined.scale([1,1,-1]);
  const flipped = scaled.translate([0,0,p.coverThickness]);
  scaled.delete();
  joined.delete();
  const original = flipped.asOriginal();
  flipped.delete();
  // 与整盖使用相同的导出规范化，试装件也必须通过严格闭边校验。
  const canonical = original.simplify(.001);
  original.delete();
  const verification = verifySolid(canonical);
  const triangles = meshTriangles(verification.mesh);
  canonical.delete();
  return { triangles, baseDiameter:baseRadius * 2, verification:{ ...verification, mesh:undefined } };
}

export function trialBaseRadius(p) {
  return Math.hypot(
    p.contactLength / 2 + p.rootFlare + 3,
    p.openingWidth / 2 + p.hookReach + 3
  );
}
