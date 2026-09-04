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
const detachableRootOverlap = .2;
const socketRibFloorOverlap = .12;

function estimateTaperedStrain(rootWidth, tipWidth, rootThickness, tipThickness, length, deflection) {
  // 以变截面悬臂的弯曲柔度反算载荷，再取各截面的最大表面应变。
  if (length <= 0) return Infinity;
  const samples = 64;
  const step = length / samples;
  let compliance = 0;
  const sections = [];
  for (let index = 0; index < samples; index += 1) {
    const x = (index + .5) * step;
    const ratio = x / length;
    const width = rootWidth + (tipWidth - rootWidth) * ratio;
    const thickness = rootThickness + (tipThickness - rootThickness) * ratio;
    const inertia = width * thickness ** 3 / 12;
    const momentArm = length - x;
    compliance += momentArm ** 2 / inertia * step;
    sections.push({ thickness, inertia, momentArm });
  }
  const loadOverModulus = deflection / compliance;
  return Math.max(...sections.map(({ thickness, inertia, momentArm }) =>
    loadOverModulus * momentArm * thickness / (2 * inertia)
  )) * 100;
}

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
    coverThickness:clamp(raw.coverThickness ?? raw.coverDiameter * .012, 1.2, 6),
    skirtHeight:clamp(raw.skirtHeight ?? 0, 0, 30),
    skirtThickness:clamp(raw.skirtThickness ?? 2, 1.2, 8),
    outerRingWidth:clamp(raw.coverDiameter * .04, 6, 14),
    contactLength:clamp(raw.spokeBackDepth * strength.contactRatio, strength.contactMin, strength.contactMax),
    legThickness:clamp(raw.spokeBackDepth / strength.thicknessDivisor, strength.thicknessMin, strength.thicknessMax),
    rootHeight:clamp(raw.spokeBackDepth * strength.rootRatio, strength.rootMin, strength.rootMax),
    sideClearance:fit.sideClearance,
    hookReach:fit.hookReach,
    minWall:1.2,
    nozzleWidth:.4,
    layerHeight:.2,
    colorLayerHeight:clamp(raw.colorLayerHeight ?? .4, .2, .8),
    colorPalette:Array.isArray(raw.colorPalette) && raw.colorPalette.length ? raw.colorPalette : ["#f4f0e7", "#20221f"]
  };
  const result = { ...automatic, ...(custom || {}) };
  result.attachmentMode = raw.attachmentMode === "detachable" ? "detachable" : "integrated";
  result.rootFlare = clamp(result.legThickness * strength.flareRatio, 1, 2.6);
  result.tipThickness = Math.max(1.2, result.legThickness * .72);
  result.clawRootThickness = clamp(result.legThickness * 2, 3.2, 4.2);
  result.clawTipThickness = clamp(result.legThickness * .95, 1.8, 2.2);
  result.tipWidth = Math.max(8, result.contactLength * .82);
  const defaultTopWidth = Math.min(result.contactLength - .5, Math.round(result.contactLength * .7 * 2) / 2);
  result.topWidth = clamp(result.topWidth ?? defaultTopWidth, 4, 30);
  // 导入段按 45° 上限自动计算；背面留出圆角后的承力肩，避免纯圆弧失去防脱止挡。
  result.hookLandHeight = Math.max(result.layerHeight * 3, result.nozzleWidth * 1.5, Math.min(1, result.legThickness * .35));
  result.insertionRampHeight = result.hookReach + result.sideClearance;
  result.hookHeight = result.insertionRampHeight + result.hookLandHeight;
  result.flexPerJaw = Math.max(0, result.hookReach);
  result.mount = result.attachmentMode === "detachable" ? deriveDetachableMount(result, raw.mountClearance ?? .15, raw.mountRibHeight ?? .4) : null;
  const detachableArmLength = result.mount ? Math.max(0, result.spokeBackDepth - result.mount.rootOffset) : 0;
  result.rootRigidLength = result.mount ? clamp(detachableArmLength * .28, 3, 5) : 0;
  const rigidRatio = detachableArmLength > 0 ? clamp(result.rootRigidLength / detachableArmLength, 0, 1) : 0;
  result.rootRigidWidth = result.contactLength + (result.topWidth - result.contactLength) * rigidRatio;
  result.flexibleLength = result.mount ? Math.max(0, detachableArmLength - result.rootRigidLength) : 0;
  const desiredFilletRadius = clamp(result.clawRootThickness * .75, 2.4, 3.4);
  result.rootFilletRadius = result.mount
    ? Math.min(desiredFilletRadius, Math.max(1.2, result.rootRigidLength - .25))
    : clamp(result.clawRootThickness * .55, 1.4, 2.2);
  result.freeLength = result.mount
    ? Math.max(.01, result.flexibleLength)
    : Math.max(2, result.spokeBackDepth - result.rootHeight);
  result.insertionAngle = Math.atan2(result.hookReach + result.sideClearance, result.insertionRampHeight) * 180 / Math.PI;
  result.retentionArea = result.hookReach * (result.mount ? result.topWidth : result.tipWidth);
  result.estimatedStrain = result.mount
    ? estimateTaperedStrain(
      result.rootRigidWidth, result.topWidth,
      result.clawRootThickness, result.clawTipThickness,
      result.flexibleLength, result.flexPerJaw
    )
    : 1.5 * result.legThickness * result.flexPerJaw / (result.freeLength * result.freeLength) * 100;
  return result;
}

function deriveDetachableMount(p, clearance, ribHeight) {
  const wall = 1.6, footThickness = 1.6, lipThickness = 1.2;
  const bridgeThickness = clamp(p.clawRootThickness * .8, 3, 3.6);
  const outerWidth = p.openingWidth - p.sideClearance * 2;
  const footWidth = outerWidth - 2 * (wall + clearance);
  // 安装头、承力桥与爪片根部共用同一个底面宽度，不再产生缩进或外凸台阶。
  const length = p.contactLength;
  const footBottom = clearance + footThickness;
  const socketDepth = footBottom + clearance + lipThickness;
  const bridgeTop = socketDepth + clearance;
  const rootOffset = bridgeTop + bridgeThickness;
  const lipOverlap = .7;
  const lipInner = footWidth / 2 - lipOverlap;
  const neckWidth = Math.max(0, 2 * (lipInner - clearance - .05));
  // 承力桥延伸到两条爪片的外侧面，使根部按完整爪片厚度连续连接。
  const bridgeWidth = outerWidth;
  const footShift = 0;
  const footMin = -length / 2;
  // 横棱位于滑槽底面入口；坡长按完整截面高度计算，保证实际导入坡不超过 30°、防退坡不超过 45°。
  const ribProfileHeight = ribHeight + socketRibFloorOverlap;
  const insertionRun = Math.max(.8, ribProfileHeight / Math.tan(Math.PI / 6));
  const removalRun = Math.max(.4, ribProfileHeight);
  const ribEnd = footMin - .15;
  const ribPeak = ribEnd - removalRun;
  const ribStart = ribPeak - insertionRun;
  const ribSpan = Math.max(6, footWidth - 2);
  const ribBaseWidth = ribEnd - ribStart;
  const ribInsertionAngle = degrees(Math.atan2(ribProfileHeight, insertionRun));
  const ribRemovalAngle = degrees(Math.atan2(ribProfileHeight, removalRun));
  const ribTailClearance = footMin - ribEnd;
  // 滑块可先占用上下两侧装配间隙，剩余值才是需要零件弹性让位的有效压入量。
  const ribInterference = Math.max(0, ribHeight - 2 * clearance);
  const radialMin = ribStart - .4;
  const radialMax = p.contactLength / 2 + clearance + wall;
  return {
    clearance, wall, footThickness, lipThickness, bridgeThickness, outerWidth, footWidth, length,
    footBottom, socketDepth, bridgeTop, rootOffset, lipOverlap, lipInner, neckWidth, bridgeWidth, footShift,
    ribHeight, ribProfileHeight, ribStart, ribPeak, ribEnd, ribSpan, ribBaseWidth,
    ribInsertionAngle, ribRemovalAngle, ribTailClearance, ribInterference,
    radialMin, radialMax
  };
}

function validateDetachableMount(p) {
  const m = p.mount;
  if (!m) return [];
  const errors = [];
  if (!Number.isFinite(m.clearance) || m.clearance < .05 || m.clearance > .3) errors.push("滑块单侧摩擦间隙必须在 0.05–0.30 mm 之间");
  if (!Number.isFinite(m.ribHeight) || m.ribHeight < .25 || m.ribHeight > .6) errors.push("入口横向防退棱高度必须在 0.25–0.60 mm 之间");
  if (m.footWidth < 8 || m.neckWidth < 8) errors.push("轮辐开口过窄，无法为实心滑块、宽根颈和刚性固定座保留足够空间");
  if (p.flexibleLength < 6) errors.push("总深度不足：加厚根部后至少需要保留 6 mm 弹性渐缩段，请增大总深度或使用一体爪钩");
  if (m.ribInterference < .049) errors.push("入口横向防退棱未高出上下总间隙至少 0.05 mm，无法形成可靠防退");
  if (m.ribInterference > .3) errors.push("入口横向防退棱有效压入量超过 0.30 mm，滑块可能无法安全越过");
  return errors;
}

function mountFootprintsOverlap(p, first, second) {
  const m = p.mount;
  const halfRadial = (m.radialMax - m.radialMin) / 2 + .5;
  const halfTangent = Math.max(m.outerWidth / 2, p.openingWidth / 2 + p.hookReach) + .5;
  const radius = p.clipRadius + (m.radialMax + m.radialMin) / 2;
  const boxes = [first, second].map((index) => {
    const angle = p.startAngle + 2 * Math.PI * index / p.clipCount;
    const radial = [Math.cos(angle), Math.sin(angle)], tangent = [-radial[1], radial[0]];
    return { center:radial.map((value) => value * radius), radial, tangent };
  });
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const delta = boxes[1].center.map((value, index) => value - boxes[0].center[index]);
  return boxes.flatMap((box) => [box.radial, box.tangent]).every((axis) => {
    const extent = boxes.reduce((sum, box) => sum + halfRadial * Math.abs(dot(axis, box.radial)) + halfTangent * Math.abs(dot(axis, box.tangent)), 0);
    return Math.abs(dot(delta, axis)) < extent;
  });
}

export function clipMetrics(p, activeIndices) {
  const pairWidth = p.openingWidth + 2 * p.hookReach;
  const jawThickness = p.mount ? p.clawRootThickness : p.tipThickness;
  return {
    coverRadius:p.coverDiameter / 2,
    pairWidth,
    jawOuterSpan:p.openingWidth - p.sideClearance * 2,
    centerGap:p.openingWidth - 2 * (p.sideClearance + jawThickness),
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
  if (p.coverThickness < 1.6) warnings.push("盖板厚度低于 1.6 mm，建议先验证卡爪根部刚度");
  if (p.skirtHeight > 0 && p.skirtThickness >= m.coverRadius - 2) errors.push("裙边厚度过大，内径不足");
  if (p.skirtHeight > 0 && p.skirtHeight / p.skirtThickness > 15) warnings.push("裙边较高且较薄，注意打印翘曲和振动摆动");
  if (p.skirtHeight > p.spokeBackDepth) warnings.push("裙边高度超过卡扣总深度，请确认不会与轮毂或车轮干涉");
  if (p.mode === "color" && p.coverThickness - p.colorLayerHeight < .4 - 1e-6) errors.push("彩色层下方必须至少保留 0.4 mm 盖板主体");
  if (m.availableArc < 3) errors.push("相邻卡爪间距小于 3 mm");
  if (!p.mount && p.spokeBackDepth <= p.rootHeight + 2) errors.push("卡扣总深度过短，无法保留根部渐变区和弹性直段");
  if (p.contactLength < 6) errors.push("爪片底面宽度不能小于 6 mm");
  else if (p.contactLength < 8) warnings.push("爪片底面宽度低于 8 mm，根部承力面积较小，请先试打");
  if (p.legThickness < 1.2) errors.push("卡爪根部厚度不能小于 1.2 mm");
  if (p.mount && p.topWidth >= p.contactLength - .05) errors.push("爪片顶面宽度必须小于底面宽度，才能形成连续收缩");
  if (p.mount && p.topWidth < 4) errors.push("爪片顶面宽度不能小于 4 mm");
  else if (p.mount && p.topWidth < 8) warnings.push("爪片顶面宽度低于 8 mm，倒钩承力面积较小，请先试打");
  if (!p.mount && p.tipThickness + 1e-6 < p.nozzleWidth * 3) errors.push("卡爪末端不足 3 道喷嘴线宽");
  if (p.sideClearance < .1) errors.push("单侧装配间隙不能小于 0.1 mm");
  if (m.centerGap < 2) errors.push("轮辐开口过窄，双爪之间的弹性间隙不足 2 mm");
  if (p.hookReach < .3) errors.push("每侧倒钩外伸量不能小于 0.3 mm");
  const hookThickness = p.mount ? p.clawTipThickness : p.legThickness;
  if (p.hookReach > hookThickness * 1.25) errors.push("倒钩外伸量相对爪片末端厚度过大，末端应力过高");
  if (p.retentionArea < 6) warnings.push("单爪承力面积偏小，建议增加倒钩外伸量或爪片径向宽度");
  if (Number.isFinite(p.estimatedStrain) && p.estimatedStrain > 3) errors.push(`预计卡爪应变 ${p.estimatedStrain.toFixed(1)}%，超过 PETG 设计筛查上限 3%`);
  else if (Number.isFinite(p.estimatedStrain) && p.estimatedStrain > 2) warnings.push(`预计卡爪应变 ${p.estimatedStrain.toFixed(1)}%，建议先打印单组试装`);
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
  if (p.mount) {
    errors.push(...validateDetachableMount(p));
    const mountingRadius = Math.hypot(p.clipRadius + p.mount.radialMax + 2, p.mount.outerWidth / 2 + 2);
    if (p.clipRadius + p.mount.radialMin - 2 < 3 || mountingRadius > m.coverRadius) errors.push("可拆固定座或保护区越过盖板边界，请调整安装半径或盖板外径");
    if (p.skirtHeight > 0 && mountingRadius > m.coverRadius - p.skirtThickness - .5) errors.push("可拆固定座与裙边空间冲突，请减小安装半径或裙边厚度");
    if (activeIndices.some((first, i) => activeIndices.slice(i + 1).some((second) => mountFootprintsOverlap(p, first, second)))) errors.push("相邻可拆固定座或卡爪空间重叠，请减少组数或增大安装半径");
    if (p.mount.clearance > .2) warnings.push("滑块摩擦间隙大于 0.20 mm，保持力可能不足，请先配对试印");
    if (p.mount.ribInterference > .2) warnings.push("入口横向防退棱有效压入量超过 0.20 mm，拆装阻力可能较大");
    warnings.push("可拆结构需先配对试印：从圆心向外推入，滑块尾端越过底面横棱；拆下整盖后可用持续拉力反向取出");
  }
  return { valid:errors.length === 0, errors, warnings };
}

export function validateTrialClip(p) {
  const errors = [];
  if (!p.mount && p.spokeBackDepth <= p.rootHeight + 2) errors.push("卡扣总深度过短");
  if (p.contactLength < 6 || p.legThickness < 1.2 || p.sideClearance < .1) errors.push("卡爪基础尺寸过小");
  if (p.mount && (p.topWidth < 4 || p.topWidth >= p.contactLength)) errors.push("爪片底面或顶面宽度无效");
  const jawThickness = p.mount ? p.clawRootThickness : p.tipThickness;
  if (p.openingWidth - 2 * (p.sideClearance + jawThickness) < 2) errors.push("轮辐开口无法为双爪保留足够弹性间隙");
  const hookThickness = p.mount ? p.clawTipThickness : p.legThickness;
  if (p.hookReach < .3 || p.hookReach > hookThickness * 1.25) errors.push("倒钩外伸量无效");
  if (Number.isFinite(p.estimatedStrain) && p.estimatedStrain > 3) errors.push("预计卡爪应变超过 3%");
  errors.push(...validateDetachableMount(p));
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

function buildSupportFreeArm(wasm, p, angle, side) {
  const { Manifold } = wasm;
  const angleDegrees = degrees(angle);
  const rootOverlap = detachableRootOverlap;
  const tipOverlap = Math.min(.3, p.hookLandHeight / 2);
  const sectionDepth = Math.min(.3, p.layerHeight * 1.5);
  // 根部截面与加厚承力桥完整相交；底面宽度精确等于底座宽度。
  // 先保留一段等截面的刚性根段承担弯矩，再从根段末端以连续平面渐缩到弹性顶端。
  const root = clawSection(
    Manifold, p, angleDegrees, side, p.contactLength, p.clawRootThickness,
    -rootOverlap, p.mount.bridgeThickness + rootOverlap
  );
  const rigidEnd = clawSection(
    Manifold, p, angleDegrees, side, p.rootRigidWidth, p.clawRootThickness,
    -p.rootRigidLength, sectionDepth
  );
  const rigidBody = hullPair(Manifold, root, rigidEnd);
  const taperStart = clawSection(
    Manifold, p, angleDegrees, side, p.rootRigidWidth, p.clawRootThickness,
    -p.rootRigidLength, sectionDepth
  );
  const tip = clawSection(
    Manifold, p, angleDegrees, side, p.topWidth, p.clawTipThickness,
    -p.spokeBackDepth - tipOverlap, tipOverlap + .2
  );
  const elasticTaper = hullPair(Manifold, taperStart, tip);
  return unionAndDispose(Manifold, [rigidBody, elasticTaper]);
}

function buildDetachableRootFillet(wasm, p, angle, side) {
  const { Manifold } = wasm;
  const edge = p.openingWidth / 2;
  const outerFace = edge - p.sideClearance;
  const rootInnerFace = outerFace - p.clawRootThickness;
  const radius = Math.min(p.rootFilletRadius, p.rootRigidLength - .2);
  const centerT = rootInnerFace - radius;
  const overlap = .12;
  const profile = [{ t:centerT, z:overlap }];
  // 四分之一圆同时与承力桥底面和刚性根段内侧面相切，避免连接处出现折线。
  for (let step = 0; step <= 12; step += 1) {
    const theta = Math.PI / 2 * (1 - step / 12);
    profile.push({
      t:centerT + radius * Math.cos(theta),
      z:-radius + radius * Math.sin(theta)
    });
  }
  profile.push(
    { t:rootInnerFace + overlap, z:-radius },
    { t:rootInnerFace + overlap, z:overlap }
  );
  const oriented = side > 0 ? profile : profile.map((point) => ({ t:-point.t, z:point.z })).reverse();
  const fillet = manifoldFromProfilePrism(
    wasm,
    angle,
    p.clipRadius - p.contactLength / 2,
    p.clipRadius + p.contactLength / 2,
    oriented
  );
  const tangentSpan = p.openingWidth + p.clawRootThickness * 2;
  const angleDegrees = degrees(angle);
  const rootEnvelope = transformedBox(
    Manifold,
    [p.contactLength, tangentSpan, p.mount.bridgeThickness + detachableRootOverlap],
    [p.clipRadius - p.contactLength / 2, -tangentSpan / 2, -detachableRootOverlap],
    angleDegrees
  );
  const rigidEnvelope = transformedBox(
    Manifold,
    [p.rootRigidWidth, tangentSpan, .3],
    [p.clipRadius - p.rootRigidWidth / 2, -tangentSpan / 2, -p.rootRigidLength],
    angleDegrees
  );
  // 圆角服从底宽到顶宽的同一直线包络，径向两端不会出现折线或尖薄凸片。
  const radialEnvelope = hullPair(Manifold, rootEnvelope, rigidEnvelope);
  const clipped = fillet.intersect(radialEnvelope);
  dispose(fillet, radialEnvelope);
  return clipped;
}

function buildHook(wasm, p, angle, side) {
  const edge = p.openingWidth / 2;
  const hookOuter = edge + p.hookReach;
  const tipRadius = Math.min(.3, p.hookLandHeight * .45, p.hookReach * .35);
  const makeProfile = (width, armOuter = edge - p.sideClearance) => {
    const armInner = armOuter - width;
    const backFace = -p.spokeBackDepth;
    const leadingFace = backFace - p.hookHeight;
    const rampEnd = leadingFace + p.insertionRampHeight;
    const ramp = [];
    // 三次贝塞尔逼近圆滑的 45° 导入：起点与爪片相切，终点与承力肩相切。
    for (let step = 1; step <= 6; step += 1) {
      const t = step / 6, reverse = 1 - t;
      ramp.push({
        t:reverse ** 3 * armOuter + 3 * reverse ** 2 * t * (armOuter + (hookOuter - armOuter) * .62) + 3 * reverse * t ** 2 * hookOuter + t ** 3 * hookOuter,
        z:reverse ** 3 * leadingFace + 3 * reverse ** 2 * t * leadingFace + 3 * reverse * t ** 2 * (rampEnd - (rampEnd - leadingFace) * .38) + t ** 3 * rampEnd
      });
    }
    const roundedShoulder = [];
    for (let step = 1; step <= 4; step += 1) {
      const theta = Math.PI * step / 8;
      roundedShoulder.push({
        t:hookOuter - tipRadius + tipRadius * Math.cos(theta),
        z:backFace - tipRadius + tipRadius * Math.sin(theta)
      });
    }
    return [
      { t:armInner, z:leadingFace },
      { t:armOuter, z:leadingFace },
      ...ramp,
      { t:hookOuter, z:backFace - tipRadius },
      ...roundedShoulder,
      { t:armInner, z:backFace }
    ];
  };
  const orient = (points) => side > 0 ? points : points.map((point) => ({ t:-point.t, z:point.z })).reverse();
  if (p.mount) {
    const profile = makeProfile(p.clawTipThickness);
    const radial0 = p.clipRadius - p.topWidth / 2;
    const radial1 = p.clipRadius + p.topWidth / 2;
    return manifoldFromProfilePrism(wasm, angle, radial0, radial1, orient(profile));
  }
  const profile = makeProfile(p.tipThickness);
  const radial0 = p.clipRadius - p.tipWidth / 2;
  const radial1 = p.clipRadius + p.tipWidth / 2;
  return manifoldFromProfilePrism(wasm, angle, radial0, radial1, orient(profile));
}

function buildClipSolids(wasm, p, activeIndices) {
  const { Manifold } = wasm;
  const groups = activeIndices.map((index) => {
    const angle = p.startAngle + Math.PI * 2 * index / p.clipCount;
    const parts = [];
    [-1, 1].forEach((side) => {
      parts.push(p.mount ? buildSupportFreeArm(wasm, p, angle, side) : buildTaperedArm(wasm, p, angle, side));
      if (p.mount) parts.push(buildDetachableRootFillet(wasm, p, angle, side));
      parts.push(buildHook(wasm, p, angle, side));
    });
    return unionAndDispose(Manifold, parts);
  });
  return unionAndDispose(Manifold, groups);
}

function buildDetachableSocket(wasm, p) {
  const { Manifold, CrossSection } = wasm;
  const m = p.mount, half = m.footWidth / 2, outer = m.outerWidth / 2, sx = m.footShift;
  const box = (x0, x1, y0, y1, z0, z1) => transformedBox(Manifold, [x1-x0, y1-y0, z1-z0], [x0,y0,z0]);
  const pieces = [box(sx+m.length/2+m.clearance, m.radialMax, -outer, outer, -m.socketDepth, .12)];
  [-1, 1].forEach((side) => {
    const inner = half + m.clearance;
    pieces.push(box(m.radialMin, m.radialMax, side > 0 ? inner : -outer, side > 0 ? outer : -inner, -m.socketDepth, .12));
    pieces.push(box(m.radialMin, m.radialMax, side > 0 ? m.lipInner : -outer, side > 0 ? outer : -m.lipInner, -m.socketDepth, -m.footBottom - m.clearance));
  });
  const ribSection = CrossSection.ofPolygons([[
    [m.ribStart, socketRibFloorOverlap],
    [m.ribPeak, -m.ribHeight],
    [m.ribEnd, socketRibFloorOverlap]
  ]], "Positive");
  const ribRaw = Manifold.extrude(ribSection, m.ribSpan);
  ribSection.delete();
  // 截面位于径向-轴向平面，再沿切向展开为横跨滑块入口的连续底面棱。
  const rib = ribRaw.transform([
    1,0,0,0,
    0,0,1,0,
    0,1,0,0,
    0,-m.ribSpan/2,0,1
  ]);
  ribRaw.delete();
  pieces.push(rib);
  // 固定座底面入口只保留一条横向缓坡棱；滑块完全推入后尾端越过它。
  return unionAndDispose(Manifold, pieces);
}

function buildDetachableClip(wasm, p) {
  const { Manifold } = wasm;
  const m = p.mount;
  if (validateDetachableMount(p).length) throw new Error(validateDetachableMount(p)[0]);
  const half = m.footWidth / 2, sx = m.footShift;
  const footMin = sx-m.length/2;
  const foot = transformedBox(Manifold, [m.length,m.footWidth,m.footThickness], [footMin,-half,-m.footBottom]);
  const rootWidth = p.contactLength;
  const rootMin = -rootWidth/2;
  // 实心滑块不挖槽；根颈只为两侧最小捕获边让位，随后以单一平面扩展到完整承力桥。
  const neckStem = transformedBox(Manifold, [m.length,m.neckWidth,m.bridgeTop-m.footBottom+.2], [footMin,-m.neckWidth/2,-m.bridgeTop-.1]);
  const neckTop = transformedBox(Manifold, [m.length,m.neckWidth,.3], [footMin,-m.neckWidth/2,-m.bridgeTop-.1]);
  const neckBottom = transformedBox(Manifold, [rootWidth,m.bridgeWidth,.3], [rootMin,-m.bridgeWidth/2,-m.rootOffset]);
  const neckTransition = hullPair(Manifold, neckTop, neckBottom);
  const neck = unionAndDispose(Manifold, [neckStem,neckTransition]);
  const bridge = transformedBox(Manifold, [rootWidth,m.bridgeWidth,m.bridgeThickness], [rootMin,-m.bridgeWidth/2,-m.rootOffset]);
  const local = { ...p, clipRadius:0, clipCount:1, startAngle:0, spokeBackDepth:p.spokeBackDepth-m.rootOffset };
  const clawsRaw = buildClipSolids(wasm, local, [0]);
  const claws = clawsRaw.translate([0,0,-m.rootOffset]);
  clawsRaw.delete();
  const joined = unionAndDispose(Manifold, [foot,neck,bridge,claws]);
  // 梯形凸包与圆弧倒钩相交后可能保留同坐标分裂顶点；焊接后再规范化，保证 STL 严格闭边。
  return canonicalSolid(weldSolid(Manifold, canonicalSolid(joined)));
}

function placeClipPart(solid, p, index) {
  const moved = solid.translate([p.clipRadius,0,0]);
  const placed = moved.rotate([0,0,degrees(p.startAngle + 2 * Math.PI * index / p.clipCount)]);
  moved.delete();
  return placed;
}

function buildMountSolids(wasm, p, activeIndices) {
  if (validateDetachableMount(p).length) throw new Error(validateDetachableMount(p)[0]);
  const socket = buildDetachableSocket(wasm, p);
  const placed = activeIndices.map((index) => placeClipPart(socket, p, index));
  socket.delete();
  return unionAndDispose(wasm.Manifold, placed);
}

function printableClipPart(solid) {
  // 径向侧面旋转为底面；安装脚、根桥、双爪与倒钩共用该平面，可直接无支撑侧放。
  const sideways = solid.rotate([0,90,0]);
  const bounds = sideways.boundingBox();
  const grounded = sideways.translate([-(bounds.min[0]+bounds.max[0])/2, -(bounds.min[1]+bounds.max[1])/2, -bounds.min[2]]);
  sideways.delete();
  return materialPartFromSolid(grounded, 0, "#ec6a3a", "可更换双爪卡扣（实心摩擦滑块）");
}

function addDetachableParts(wasm, p, activeIndices, geometry, coverSolid) {
  const template = canonicalSolid(buildDetachableClip(wasm, p));
  const clipParts = [];
  let occupied = null;
  try {
    const sample = printableClipPart(template);
    occupied = coverSolid.translate([0,0,0]);
    for (const index of activeIndices) {
      const placed = placeClipPart(template, p, index);
      const interference = occupied.intersect(placed);
      const overlap = interference.volume();
      interference.delete();
      if (overlap > .001) { placed.delete(); throw new Error(`C${index+1} 可拆卡扣与盖板、固定座或其他卡扣存在实体干涉`); }
      const next = occupied.add(placed);
      occupied.delete();
      occupied = next;
      const part = materialPartFromSolid(placed, 0, p.colorPalette[0], `C${index+1} 可更换卡扣`);
      // 预览区分安装座与替换件，不改变导出的耗材底色。
      part.triangles.forEach((triangle) => { triangle.color = [.93,.35,.16,1]; });
      clipParts.push({ ...part, index });
    }
    return {
      ...geometry,
      coverTriangles:geometry.bodyTriangles,
      bodyTriangles:[...geometry.bodyTriangles, ...clipParts.flatMap((part) => part.triangles)],
      clipParts,
      clipSample:sample,
      assemblyVerification:{ status:"NoError", componentCount:1+clipParts.length, invalidEdges:0, overlapVolume:0 }
    };
  } finally {
    dispose(occupied, template);
  }
}

function rootProtection(wasm, p, activeIndices) {
  const { CrossSection } = wasm;
  const radialWidth = p.contactLength + 2 * p.rootFlare + 4;
  const tangentWidth = p.openingWidth + p.minWall * 2;
  const rootInner = p.clipRadius + (p.mount ? p.mount.radialMin - 2 : -radialWidth / 2);
  const rootOuter = p.clipRadius + (p.mount ? p.mount.radialMax + 2 : radialWidth / 2);
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

function maskRectangles(mask, patternRadius, value = 1) {
  const { size, data } = mask;
  const rectangles = [];
  const scale = patternRadius * 2 / size;
  for (let row = 0; row < size; row += 1) {
    let start = -1;
    for (let column = 0; column <= size; column += 1) {
      const filled = column < size && data[row * size + column] === value;
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
  const scale = clamp(p.patternScale ?? 1, .1, 2);
  const scaled = pattern.scale(scale);
  pattern.delete();
  const smoothing = mask ? clamp(Math.round(p.patternSmoothing ?? 0), 0, 8) : 0;
  let processed = scaled;
  if (smoothing) {
    const pixelSize = patternRadius * 2 / mask.size * scale;
    const rounding = Math.min(p.minWall * .55, pixelSize * smoothing * .45);
    const closedOut = processed.offset(rounding, "Round", 2, 16);
    processed.delete();
    const closed = closedOut.offset(-rounding, "Round", 2, 16);
    closedOut.delete();
    const openedIn = closed.offset(-rounding, "Round", 2, 16);
    closed.delete();
    const opened = openedIn.offset(rounding, "Round", 2, 16);
    openedIn.delete();
    processed = opened.simplify(Math.max(.035, pixelSize * .12));
    opened.delete();
  }
  const rotation = Number.isFinite(p.patternRotation) ? p.patternRotation : 0;
  if (rotation) {
    const rotated = processed.rotate(rotation);
    processed.delete();
    processed = rotated;
  }
  const offsetX = Number.isFinite(p.patternOffsetX) ? p.patternOffsetX : 0;
  const offsetY = Number.isFinite(p.patternOffsetY) ? p.patternOffsetY : 0;
  if (!offsetX && !offsetY) return processed;
  const translated = processed.translate([offsetX, offsetY]);
  processed.delete();
  return translated;
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
  } else if (p.mode === "relief") {
    bodySection = outer;
    reliefSection = patternWithoutRoots;
  } else {
    bodySection = outer;
  }
  const contourSource = p.mode === "cut" ? bodySection : reliefSection;
  report.contourCount = contourSource ? contourSource.toPolygons().reduce((sum, polygon) => sum + polygon.length, 0) : 0;
  if (p.mode === "cut") outer.delete();
  dispose(inner, ring, protection, protectionGuard, anchors);
  if (p.mode !== "relief") patternWithoutRoots.delete();
  return { bodySection, reliefSection, report };
}

function buildOuterSkirt(wasm, p) {
  if (p.skirtHeight <= 0) return null;
  const { CrossSection } = wasm;
  const radius = p.coverDiameter / 2;
  const segments = clamp(Math.ceil(Math.PI * 2 * radius / 1.5), 160, 420);
  const outer = CrossSection.circle(radius, segments);
  const inner = CrossSection.circle(Math.max(.5, radius - p.skirtThickness), segments);
  const ring = outer.subtract(inner);
  outer.delete();
  inner.delete();
  // 向盖板内部重叠 0.1 mm，保证裙边与盖板布尔合并为一个连续实体。
  const rawSkirt = ring.extrude(p.skirtHeight + .1);
  ring.delete();
  const skirt = rawSkirt.translate([0,0,-p.skirtHeight]);
  rawSkirt.delete();
  return skirt;
}

function verifySolid(solid, strictCoordinates = true) {
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
  const invalidEdges = indexedInvalidEdges;
  if (indexedInvalidEdges || strictCoordinates && geometricInvalidEdges) throw new Error(`模型存在 ${indexedInvalidEdges + geometricInvalidEdges} 条非流形边（索引 ${indexedInvalidEdges} / 坐标 ${geometricInvalidEdges}）`);
  return {
    status,
    componentCount,
    invalidEdges,
    geometricEdgeWarnings:geometricInvalidEdges,
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

function hexToRgba(hex) {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex.slice(1) : "ec6a3a";
  return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16) / 255).concat(1);
}

function canonicalSolid(solid) {
  const original = solid.asOriginal();
  solid.delete();
  const canonical = original.simplify(.001);
  original.delete();
  return canonical;
}

function weldSolid(Manifold, solid) {
  const mesh = solid.getMesh();
  mesh.merge();
  const welded = Manifold.ofMesh(mesh);
  solid.delete();
  return welded;
}

function materialPartFromSolid(solid, materialIndex, color, name, simplify = true) {
  let canonical;
  if (simplify) canonical = canonicalSolid(solid);
  else canonical = solid;
  let verification;
  try {
    verification = verifySolid(canonical, simplify);
  } catch (error) {
    canonical.delete();
    throw new Error(`${name}：${error instanceof Error ? error.message : String(error)}`);
  }
  const result = {
    materialIndex,
    color,
    name,
    triangles:meshTriangles(verification.mesh, hexToRgba(color)),
    exportMesh:indexedMesh(verification.mesh),
    verification:{ ...verification, mesh:undefined }
  };
  canonical.delete();
  return result;
}

function makeColorSection(wasm, p, mask, label, outer) {
  const { CrossSection } = wasm;
  const rectangles = maskRectangles(mask, p.coverDiameter / 2, label);
  if (!rectangles.length) return null;
  const raw = new CrossSection(rectangles, "Positive");
  const simplified = raw.simplify(Math.max(.025, p.coverDiameter / 10000));
  raw.delete();
  const clipped = simplified.intersect(outer);
  simplified.delete();
  if (Math.abs(clipped.area()) < .01) {
    clipped.delete();
    return null;
  }
  return clipped;
}

function addBodyAttachments(wasm, p, activeIndices, cover) {
  let body = cover;
  const skirt = buildOuterSkirt(wasm, p);
  if (skirt) {
    const united = body.add(skirt);
    dispose(body, skirt);
    body = united;
  }
  const clips = p.mount ? buildMountSolids(wasm, p, activeIndices) : buildClipSolids(wasm, p, activeIndices);
  const joined = body.add(clips);
  dispose(body, clips);
  return joined;
}

async function buildColorHubcapGeometry(wasm, p, activeIndices, mask) {
  const { Manifold, CrossSection } = wasm;
  const radius = p.coverDiameter / 2;
  const segments = clamp(Math.ceil(Math.PI * 2 * radius / 1.5), 160, 420);
  const palette = p.colorPalette.slice(0, 8);
  const masterCover = Manifold.cylinder(p.coverThickness, radius, radius, segments);
  const masterSolid = canonicalSolid(addBodyAttachments(wasm, p, activeIndices, masterCover));
  const verification = verifySolid(masterSolid);
  const exportMesh = indexedMesh(verification.mesh);
  const exportTriangles = meshTriangles(verification.mesh, hexToRgba(palette[0]));

  const outer = CrossSection.circle(radius, segments);
  const colorSections = [];
  let allocated = null;
  if (mask?.data?.length) {
    for (let label = 1; label < palette.length; label += 1) {
      let section = makeColorSection(wasm, p, mask, label, outer);
      if (!section) continue;
      if (allocated) {
        const disjoint = section.subtract(allocated);
        section.delete();
        section = disjoint;
      }
      if (Math.abs(section.area()) < .01) { section.delete(); continue; }
      colorSections.push({ label, section });
      const nextAllocated = allocated ? CrossSection.union([allocated, section]) : CrossSection.union([section]);
      if (allocated) allocated.delete();
      allocated = nextAllocated;
    }
  }
  const occupied = allocated;
  const materialHeight = p.colorLayerHeight;
  const materialBottom = p.coverThickness - p.colorLayerHeight;
  const baseCover = Manifold.cylinder(p.coverThickness, radius, radius, segments);
  let baseBody = addBodyAttachments(wasm, p, activeIndices, baseCover);
  if (occupied) {
    const cutRaw = occupied.extrude(materialHeight + .01);
    const cut = cutRaw.translate([0, 0, materialBottom]);
    cutRaw.delete();
    const carved = baseBody.subtract(cut);
    dispose(baseBody, cut);
    baseBody = carved;
  }
  const baseSolids = baseBody.decompose();
  baseBody.delete();
  const printableBaseSolids = baseSolids.filter((solid) => {
    if (solid.volume() > .001 && solid.getMesh().triVerts.length) return true;
    solid.delete();
    return false;
  });
  const materialParts = printableBaseSolids.map((solid, index) => materialPartFromSolid(
    // 先按实际导出精度焊接再规范化，清掉裁圆边界在浮点量化后形成的重合边。
    p.mount ? canonicalSolid(weldSolid(Manifold, canonicalSolid(solid))) : solid,
    0,
    palette[0],
    index === 0 ? "背景底色与结构主体" : `背景底色区域 ${index + 1}`,
    false
  ));
  let colorComponentCount = 0;
  for (const entry of colorSections) {
    const components = entry.section.decompose();
    components.forEach((component, componentIndex) => {
      const raw = component.extrude(materialHeight);
      component.delete();
      const solid = raw.translate([0, 0, materialBottom]);
      raw.delete();
      const normalized = weldSolid(Manifold, canonicalSolid(solid));
      const solidParts = normalized.decompose();
      normalized.delete();
      colorComponentCount += solidParts.length;
      if (materialParts.length + colorComponentCount > 400) {
        dispose(solidParts);
        throw new Error("彩色色块超过 400 个，请提高最小色块宽度或减少颜色数量");
      }
      solidParts.forEach((solidPart, solidPartIndex) => {
        materialParts.push(materialPartFromSolid(
          p.mount ? canonicalSolid(weldSolid(Manifold, canonicalSolid(solidPart))) : solidPart,
          entry.label,
          palette[entry.label],
          `颜色 ${entry.label + 1} · 区域 ${componentIndex + 1}.${solidPartIndex + 1}`,
          false
        ));
      });
    });
  }
  const materialVolume = materialParts.reduce((sum, part) => sum + part.verification.volume, 0);
  const volumeDelta = Math.abs(materialVolume - verification.volume);
  if (volumeDelta > Math.max(.05, verification.volume * 1e-5)) {
    throw new Error(`分色实体与完整母体体积不一致（差值 ${volumeDelta.toFixed(3)} mm³）`);
  }
  let partitionDifference = 0, partitionOverlap = 0;
  if (p.mount) {
    const solids = materialParts.map((part) => Manifold.ofMesh({
      numProp:3,
      vertProperties:Float32Array.from(part.exportMesh.vertices.flat()),
      triVerts:Uint32Array.from(part.exportMesh.triangles.flat())
    }));
    const combined = unionAndDispose(Manifold, solids);
    const missing = masterSolid.subtract(combined), extra = combined.subtract(masterSolid);
    partitionDifference = Math.abs(missing.volume()) + Math.abs(extra.volume());
    partitionOverlap = Math.max(0, materialVolume - combined.volume());
    const status = combined.status();
    dispose(combined, missing, extra);
    const tolerance = Math.max(.05, verification.volume * 1e-5);
    if (status !== "NoError" || partitionDifference > tolerance || partitionOverlap > tolerance) throw new Error("分色组合与完整盖板不一致，请简化图案后重试");
  }
  const bodyTriangles = materialParts.flatMap((part) => part.triangles);
  dispose(outer, occupied);
  colorSections.forEach((entry) => entry.section.delete());
  const geometry = {
    bodyTriangles,
    exportTriangles,
    exportMesh,
    materialParts,
    referenceTriangles:referenceTriangles(p, activeIndices),
    report:{ wallAdjusted:false, islandsRemoved:0, contourCount:colorComponentCount, colorPartCount:materialParts.length, volumeDelta, partitionDifference, partitionOverlap },
    verification:{ ...verification, mesh:undefined }
  };
  try { return p.mount ? addDetachableParts(wasm, p, activeIndices, geometry, masterSolid) : geometry; }
  finally { masterSolid.delete(); }
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
    if (p.mount) {
      const tail = p.clipRadius - p.mount.length / 2;
      // 黄色细线只标记滑块完全到位后的尾端，不进入 STL/3MF。
      addBox(
        angle,
        tail - .13,
        tail - .02,
        -p.mount.footWidth / 2 - .5,
        p.mount.footWidth / 2 + .5,
        -p.mount.socketDepth - .18,
        .3,
        [1,.78,.04,1]
      );
    }
  });
  return triangles;
}

export async function buildHubcapGeometry(p, activeIndices, mask) {
  const wasm = await initializeGeometryKernel();
  const { Manifold } = wasm;
  if (p.mode === "color") return buildColorHubcapGeometry(wasm, p, activeIndices, mask);
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
  const skirt = buildOuterSkirt(wasm, p);
  if (skirt) {
    const united = cover.add(skirt);
    dispose(cover, skirt);
    cover = united;
  }
  const clips = p.mount ? buildMountSolids(wasm, p, activeIndices) : buildClipSolids(wasm, p, activeIndices);
  const joined = cover.add(clips);
  dispose(cover, clips);
  const original = joined.asOriginal();
  joined.delete();
  // 折叠布尔运行段的共面接缝，保证 STL 按坐标焊接后仍为二流形。
  const solid = original.simplify(.001);
  original.delete();
  const verification = verifySolid(solid);
  const bodyTriangles = meshTriangles(verification.mesh, p.mount ? [.16,.47,.45,1] : undefined);
  const exportMesh = indexedMesh(verification.mesh);
  const geometry = {
    bodyTriangles,
    exportTriangles:bodyTriangles,
    exportMesh,
    materialParts:[],
    referenceTriangles:referenceTriangles(p, activeIndices),
    report,
    verification:{ ...verification, mesh:undefined }
  };
  try { return p.mount ? addDetachableParts(wasm, p, activeIndices, geometry, solid) : geometry; }
  finally { solid.delete(); }
}

export async function buildTrialClipGeometry(p) {
  const wasm = await initializeGeometryKernel();
  const { Manifold } = wasm;
  if (p.mount) {
    const solid = canonicalSolid(buildDetachableClip(wasm, p));
    try { return printableClipPart(solid); }
    finally { solid.delete(); }
  }
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
  if (p.mount) return Math.hypot(Math.max(-p.mount.radialMin, p.mount.radialMax)+3, p.mount.outerWidth/2+3);
  return Math.hypot(
    p.contactLength / 2 + p.rootFlare + 3,
    p.openingWidth / 2 + p.hookReach + 3
  );
}

export async function buildSocketTrialGeometry(p) {
  const wasm = await initializeGeometryKernel();
  if (!p.mount) throw new Error("请先选择可拆卸卡扣");
  const radius = trialBaseRadius(p);
  const base = wasm.Manifold.cylinder(p.coverThickness, radius, radius, 120);
  const socket = buildDetachableSocket(wasm, p);
  const joined = unionAndDispose(wasm.Manifold, [base, socket]);
  const rotated = joined.rotate([180,0,0]);
  joined.delete();
  const grounded = rotated.translate([0,0,p.coverThickness]);
  rotated.delete();
  return materialPartFromSolid(grounded, 0, "#2e7771", "单组刚性滑槽试装座");
}
