import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCreateJobPlan,
  createStepIdFromStatus,
  resolveCreateJobPipeline,
  type CreateJobPlan,
} from "./createJobPlan.ts";
import type { Kunde } from "./tauri.ts";

function baseKunde(over: Partial<Kunde> = {}): Kunde {
  return {
    form_mode: "manual",
    gast: "Max",
    tandemmaster: "",
    videospringer: "",
    datum: "",
    ort: "",
    handcam_video: true,
    outside_video: false,
    handcam_foto: false,
    outside_foto: false,
    ist_bezahlt_handcam_video: true,
    ist_bezahlt_outside_video: true,
    ist_bezahlt_handcam_foto: true,
    ist_bezahlt_outside_foto: true,
    ...over,
  } as Kunde;
}

describe("buildCreateJobPlan outro mux labels", () => {
  it("labels Intro+Video+Outro when both are on", () => {
    const plan = buildCreateJobPlan({
      kunde: baseKunde(),
      videoCount: 2,
      photoCount: 0,
      watermarkPhotoCount: 0,
      uploadToServer: false,
      manualEntryMode: "lokal",
      introEnabled: true,
      outroEnabled: true,
      introMuxMode: "capcut",
    });
    const mux = plan.steps.find((s) => s.id === "intro-video");
    assert.equal(mux?.labelKey, "workflow.createSteps.introVideoOutro");
    assert.ok(plan.steps.some((s) => s.id === "intro-audio"));
  });

  it("labels Video+Outro when only outro is on", () => {
    const plan = buildCreateJobPlan({
      kunde: baseKunde(),
      videoCount: 1,
      photoCount: 0,
      watermarkPhotoCount: 0,
      uploadToServer: false,
      manualEntryMode: "lokal",
      introEnabled: false,
      outroEnabled: true,
      introMuxMode: "capcut",
    });
    assert.ok(plan.steps.some((s) => s.id === "body-join"));
    const mux = plan.steps.find((s) => s.id === "intro-video");
    assert.equal(mux?.labelKey, "workflow.createSteps.videoOutro");
  });
});

describe("createStepIdFromStatus CapCut/Outro", () => {
  function muxPlan(): CreateJobPlan {
    return buildCreateJobPlan({
      kunde: baseKunde(),
      videoCount: 1,
      photoCount: 0,
      watermarkPhotoCount: 0,
      uploadToServer: false,
      manualEntryMode: "lokal",
      introEnabled: true,
      outroEnabled: true,
      introMuxMode: "capcut",
    });
  }

  it("keeps CapCut Outro encode on intro-video, not Audio", () => {
    const plan = muxPlan();
    assert.equal(
      createStepIdFromStatus(
        "Exportiere Intro+Video+Outro (Universal)…",
        plan,
      ),
      "intro-video",
    );
  });

  it("does not leap to Audio on speculative Video fertig", () => {
    const plan = muxPlan();
    assert.equal(createStepIdFromStatus("Video fertig", plan), "intro-video");
  });

  it("only Audio anhängen lights the Audio chip", () => {
    const plan = muxPlan();
    assert.equal(
      createStepIdFromStatus("Audio anhängen (Copy)…", plan),
      "intro-audio",
    );
  });

  it("monotonic stepper stays on Intro+Video+Outro after speculative Video fertig", () => {
    const plan = muxPlan();
    const afterSpec = resolveCreateJobPipeline({
      plan,
      status: "Video fertig",
      uploading: false,
      busy: true,
      reachedIndex: 0,
    });
    assert.equal(afterSpec?.steps[afterSpec.activeIndex]?.id, "intro-video");

    const duringOutro = resolveCreateJobPipeline({
      plan,
      status: "Exportiere Intro+Video+Outro (Universal)…",
      uploading: false,
      busy: true,
      reachedIndex: afterSpec!.activeIndex,
    });
    assert.equal(duringOutro?.steps[duringOutro.activeIndex]?.id, "intro-video");
    assert.notEqual(
      duringOutro?.steps[duringOutro.activeIndex]?.id,
      "intro-audio",
    );
  });
});
