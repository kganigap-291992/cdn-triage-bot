// notebook/worker/services/pdfLayoutExtractor.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PDF_LAYOUT_VERSION =
  "pdf-layout-v2-pymupdf-vector-drawings";

function safeString(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[`"'()[\]{}<>]/g, " ")
    .replace(/[^a-z0-9./:_&-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(
    max,
    Math.max(min, number)
  );
}

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function looksLikeHeading(text) {
  const line = safeString(text);

  if (!line) {
    return false;
  }

  if (
    /^\d+(\.\d+)*[.)]?\s+[A-Z0-9]/.test(
      line
    )
  ) {
    return true;
  }

  if (
    /^[A-Z][A-Za-z0-9 /:_&()!-]{2,90}$/.test(
      line
    ) &&
    !/[.!?]$/.test(line)
  ) {
    return true;
  }

  const words = line
    .split(/\s+/)
    .filter(Boolean);

  if (
    words.length >= 1 &&
    words.length <= 8
  ) {
    const titleish = words.filter(
      (word) =>
        /^[A-Z0-9][A-Za-z0-9/_:&-]*$/.test(
          word
        )
    );

    return (
      titleish.length / words.length >=
        0.65 &&
      !/[.!?]$/.test(line)
    );
  }

  return false;
}

function findPdfPath(jobDir) {
  const candidates = [
    "input.pdf",
    "document.pdf",
    "upload.pdf",
    "uploaded.pdf",
    "source.pdf",
  ].map((name) =>
    path.join(jobDir, name)
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const pdf = fs
    .readdirSync(jobDir)
    .find((file) =>
      file
        .toLowerCase()
        .endsWith(".pdf")
    );

  return pdf
    ? path.join(jobDir, pdf)
    : null;
}

function normalizeDrawingKind(
  drawing = {}
) {
  const itemTypes =
    Array.isArray(drawing.itemTypes)
      ? drawing.itemTypes
      : [];

  if (
    itemTypes.length === 1 &&
    itemTypes[0] === "re"
  ) {
    return "rectangle";
  }

  if (
    itemTypes.length === 1 &&
    itemTypes[0] === "l"
  ) {
    return "line";
  }

  if (
    itemTypes.length > 0 &&
    itemTypes.every(
      (type) => type === "l"
    )
  ) {
    return "line_path";
  }

  if (
    itemTypes.includes("c")
  ) {
    return "curve_path";
  }

  if (
    itemTypes.includes("qu")
  ) {
    return "quad_path";
  }

  return "path";
}

function normalizeDrawing(
  drawing,
  pageNumber,
  index
) {
  const x = finiteNumber(drawing.x);
  const y = finiteNumber(drawing.y);

  const width =
    finiteNumber(drawing.width);

  const height =
    finiteNumber(drawing.height);

  return {
    id:
      `p${pageNumber}-pdf-drawing-` +
      String(index + 1).padStart(
        4,
        "0"
      ),

    page: pageNumber,

    drawingKind:
      normalizeDrawingKind(
        drawing
      ),

    paintType:
      drawing.paintType || null,

    x:
      x === null
        ? null
        : clamp(x, 0, 1),

    y:
      y === null
        ? null
        : clamp(y, 0, 1),

    width:
      width === null
        ? null
        : clamp(width, 0, 1),

    height:
      height === null
        ? null
        : clamp(height, 0, 1),

    bbox:
      Array.isArray(drawing.bbox)
        ? drawing.bbox
        : null,

    strokeColor:
      Array.isArray(
        drawing.strokeColor
      )
        ? drawing.strokeColor
        : null,

    fillColor:
      Array.isArray(
        drawing.fillColor
      )
        ? drawing.fillColor
        : null,

    strokeWidth:
      finiteNumber(
        drawing.strokeWidth
      ),

    dashPattern:
      drawing.dashPattern || null,

    isDashed:
      Boolean(drawing.isDashed),

    fillOpacity:
      finiteNumber(
        drawing.fillOpacity
      ),

    strokeOpacity:
      finiteNumber(
        drawing.strokeOpacity
      ),

    closePath:
      Boolean(drawing.closePath),

    itemCount:
      Number.isInteger(
        drawing.itemCount
      )
        ? drawing.itemCount
        : 0,

    itemTypes:
      Array.isArray(
        drawing.itemTypes
      )
        ? drawing.itemTypes
        : [],

    items:
      Array.isArray(
        drawing.items
      )
        ? drawing.items
        : [],

    confidence: "real",

    source:
      "pdfLayoutExtractor:pymupdf-drawing",
  };
}

function extractPdfLayout(pdfPath) {
  if (
    !pdfPath ||
    !fs.existsSync(pdfPath)
  ) {
    return {
      version:
        PDF_LAYOUT_VERSION,

      source:
        "pdfLayoutExtractor",

      ok: false,

      reason:
        "missing_pdf",

      pages: [],
    };
  }

  const python = `
import json
import sys
import fitz

pdf_path = sys.argv[1]

doc = fitz.open(pdf_path)
pages = []

def point_to_array(point):
    if point is None:
        return None

    try:
        return [
            float(point.x),
            float(point.y),
        ]
    except Exception:
        return None


def rect_to_array(rect):
    if rect is None:
        return None

    try:
        return [
            float(rect.x0),
            float(rect.y0),
            float(rect.x1),
            float(rect.y1),
        ]
    except Exception:
        return None


def color_to_array(value):
    if value is None:
        return None

    try:
        return [
            float(x)
            for x in value
        ]
    except Exception:
        return None


def serialize_drawing_item(item):
    if not item:
        return None

    op = item[0]

    if op == "l":
        return {
            "type": "l",
            "from": point_to_array(
                item[1]
            ),
            "to": point_to_array(
                item[2]
            ),
        }

    if op == "re":
        return {
            "type": "re",
            "rect": rect_to_array(
                item[1]
            ),
            "orientation":
                item[2]
                if len(item) > 2
                else None,
        }

    if op == "qu":
        quad = item[1]

        try:
            points = [
                point_to_array(quad.ul),
                point_to_array(quad.ur),
                point_to_array(quad.ll),
                point_to_array(quad.lr),
            ]
        except Exception:
            points = []

        return {
            "type": "qu",
            "points": points,
        }

    if op == "c":
        return {
            "type": "c",
            "points": [
                point_to_array(p)
                for p in item[1:]
            ],
        }

    return {
        "type": str(op),
    }


for page_index, page in enumerate(doc):
    width = float(
        page.rect.width
    )

    height = float(
        page.rect.height
    )

    raw = page.get_text(
        "dict"
    )

    lines = []

    for block in raw.get(
        "blocks",
        []
    ):
        if block.get("type") != 0:
            continue

        for line in block.get(
            "lines",
            []
        ):
            spans = line.get(
                "spans",
                []
            )

            text = " ".join([
                s.get(
                    "text",
                    ""
                ).strip()
                for s in spans
                if s.get(
                    "text",
                    ""
                ).strip()
            ]).strip()

            if not text:
                continue

            x0, y0, x1, y1 = (
                line.get(
                    "bbox",
                    [0, 0, 0, 0]
                )
            )

            font_sizes = [
                float(
                    s.get(
                        "size",
                        0
                    )
                )
                for s in spans
                if s.get(
                    "size"
                )
            ]

            avg_size = (
                sum(font_sizes)
                / len(font_sizes)
                if font_sizes
                else 0
            )

            lines.append({
                "page":
                    page_index + 1,

                "text":
                    text,

                "x":
                    x0 / width
                    if width
                    else 0,

                "y":
                    y0 / height
                    if height
                    else 0,

                "width":
                    (x1 - x0)
                    / width
                    if width
                    else 0,

                "height":
                    (y1 - y0)
                    / height
                    if height
                    else 0,

                "fontSize":
                    avg_size,

                "bbox": [
                    x0,
                    y0,
                    x1,
                    y1,
                ],
            })

    drawings = []

    try:
        raw_drawings = (
            page.get_drawings()
        )
    except Exception:
        raw_drawings = []

    for drawing_index, drawing in enumerate(
        raw_drawings
    ):
        rect = drawing.get(
            "rect"
        )

        if rect is None:
            continue

        x0 = float(
            rect.x0
        )

        y0 = float(
            rect.y0
        )

        x1 = float(
            rect.x1
        )

        y1 = float(
            rect.y1
        )

        raw_items = drawing.get(
            "items",
            []
        )

        serialized_items = []

        item_types = []

        for item in raw_items:
            serialized = (
                serialize_drawing_item(
                    item
                )
            )

            if serialized is None:
                continue

            serialized_items.append(
                serialized
            )

            item_type = (
                serialized.get(
                    "type"
                )
            )

            if item_type:
                item_types.append(
                    item_type
                )

        dashes = drawing.get(
            "dashes"
        )

        dash_text = (
            str(dashes)
            if dashes is not None
            else None
        )

        normalized_dash = (
            dash_text
            .replace(" ", "")
            if dash_text
            else ""
        )

        is_dashed = bool(
            normalized_dash and
            not normalized_dash.startswith(
                "[]"
            )
        )

        drawings.append({
            "page":
                page_index + 1,

            "drawingIndex":
                drawing_index,

            "paintType":
                drawing.get(
                    "type"
                ),

            "x":
                x0 / width
                if width
                else 0,

            "y":
                y0 / height
                if height
                else 0,

            "width":
                (x1 - x0)
                / width
                if width
                else 0,

            "height":
                (y1 - y0)
                / height
                if height
                else 0,

            "bbox": [
                x0,
                y0,
                x1,
                y1,
            ],

            "strokeColor":
                color_to_array(
                    drawing.get(
                        "color"
                    )
                ),

            "fillColor":
                color_to_array(
                    drawing.get(
                        "fill"
                    )
                ),

            "strokeWidth":
                drawing.get(
                    "width"
                ),

            "dashPattern":
                dash_text,

            "isDashed":
                is_dashed,

            "fillOpacity":
                drawing.get(
                    "fill_opacity"
                ),

            "strokeOpacity":
                drawing.get(
                    "stroke_opacity"
                ),

            "closePath":
                bool(
                    drawing.get(
                        "closePath",
                        False
                    )
                ),

            "itemCount":
                len(
                    serialized_items
                ),

            "itemTypes":
                item_types,

            "items":
                serialized_items,
        })

    pages.append({
        "page":
            page_index + 1,

        "width":
            width,

        "height":
            height,

        "lines":
            lines,

        "drawings":
            drawings,
    })


print(
    json.dumps({
        "ok": True,

        "pageCount":
            len(pages),

        "drawingCount":
            sum(
                len(
                    page.get(
                        "drawings",
                        []
                    )
                )
                for page in pages
            ),

        "pages":
            pages,
    })
)
`;

  const result = spawnSync(
    "python3",
    [
      "-c",
      python,
      pdfPath,
    ],
    {
      encoding: "utf8",

      maxBuffer:
        1024 *
        1024 *
        50,
    }
  );

  if (result.status !== 0) {
    return {
      version:
        PDF_LAYOUT_VERSION,

      source:
        "pdfLayoutExtractor",

      ok: false,

      reason:
        "pymupdf_failed",

      error:
        result.stderr ||
        result.stdout,

      pages: [],
    };
  }

  let parsed;

  try {
    parsed =
      JSON.parse(
        result.stdout
      );
  } catch (error) {
    return {
      version:
        PDF_LAYOUT_VERSION,

      source:
        "pdfLayoutExtractor",

      ok: false,

      reason:
        "pymupdf_invalid_json",

      error:
        error.message,

      pages: [],
    };
  }

  const pages =
    (parsed.pages || []).map(
      (page) => {
        const pageNumber =
          Number(page.page);

        const lines =
          (page.lines || []).map(
            (line, index) => ({
              id:
                `p${pageNumber}-pdf-line-` +
                String(
                  index + 1
                ).padStart(
                  3,
                  "0"
                ),

              page:
                line.page,

              type:
                looksLikeHeading(
                  line.text
                )
                  ? "heading"
                  : "line",

              text:
                line.text,

              normalizedText:
                normalizeText(
                  line.text
                ),

              x:
                clamp(
                  line.x,
                  0,
                  1
                ),

              y:
                clamp(
                  line.y,
                  0,
                  1
                ),

              width:
                clamp(
                  line.width,
                  0.01,
                  1
                ),

              height:
                clamp(
                  line.height,
                  0.008,
                  0.12
                ),

              fontSize:
                line.fontSize,

              bbox:
                line.bbox,

              confidence:
                "real",

              source:
                "pdfLayoutExtractor:pymupdf-line-bbox",
            })
          );

        const drawings =
          (page.drawings || []).map(
            (
              drawing,
              index
            ) =>
              normalizeDrawing(
                drawing,
                pageNumber,
                index
              )
          );

        return {
          ...page,

          lines,
          drawings,

          stats: {
            lineCount:
              lines.length,

            drawingCount:
              drawings.length,

            rectangleCount:
              drawings.filter(
                (drawing) =>
                  drawing.drawingKind ===
                  "rectangle"
              ).length,

            lineDrawingCount:
              drawings.filter(
                (drawing) =>
                  drawing.drawingKind ===
                    "line" ||
                  drawing.drawingKind ===
                    "line_path"
              ).length,

            dashedDrawingCount:
              drawings.filter(
                (drawing) =>
                  drawing.isDashed
              ).length,
          },
        };
      }
    );

  return {
    version:
      PDF_LAYOUT_VERSION,

    source:
      "pdfLayoutExtractor",

    ok: true,

    pdfPath,

    pageCount:
      parsed.pageCount || 0,

    drawingCount:
      pages.reduce(
        (
          sum,
          page
        ) =>
          sum +
          page.stats
            .drawingCount,
        0
      ),

    rectangleCount:
      pages.reduce(
        (
          sum,
          page
        ) =>
          sum +
          page.stats
            .rectangleCount,
        0
      ),

    lineDrawingCount:
      pages.reduce(
        (
          sum,
          page
        ) =>
          sum +
          page.stats
            .lineDrawingCount,
        0
      ),

    dashedDrawingCount:
      pages.reduce(
        (
          sum,
          page
        ) =>
          sum +
          page.stats
            .dashedDrawingCount,
        0
      ),

    pages,

    notes: [
      "Text geometry is extracted from PyMuPDF text line bounding boxes.",
      "Vector drawing geometry is extracted from PyMuPDF page.get_drawings().",
      "Drawing kinds describe physical vector primitives only and do not assign architecture semantics.",
      "Dashed state preserves observed PDF stroke style and does not imply primary, secondary, failover, deployment, or relationship meaning.",
    ],
  };
}

function extractPdfLayoutForJob(
  jobDir
) {
  const pdfPath =
    findPdfPath(jobDir);

  return extractPdfLayout(
    pdfPath
  );
}

module.exports = {
  PDF_LAYOUT_VERSION,
  extractPdfLayout,
  extractPdfLayoutForJob,
  findPdfPath,
};