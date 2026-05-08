const React = require("react");
const { registerRoot, Composition } = require("remotion");

const { Root, FPS } = require("./Root");

function RemotionRoot() {
  return React.createElement(Composition, {
    id: "CacheyNotebookVideo",
    component: Root,
    durationInFrames: 900,
    fps: FPS,
    width: 1920,
    height: 1080,
    defaultProps: {
      renderPlan: {
        scenes: [],
      },
    },
  });
}

registerRoot(RemotionRoot);