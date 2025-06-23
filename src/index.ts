import WebSocket, { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { db } from './db' // Import your DB properly

dotenv.config()

const PORT = Number(process.env.PORT) || 3001

const wss = new WebSocketServer({ port: PORT })
const encoder = new TextEncoder()

console.log(`✅ WebSocket server running at ws://localhost:${PORT}`)

function sendData ({ ws, data }: { ws: WebSocket; data: unknown }) {
  ws.send(JSON.stringify(data))
}

async function generateValidJsonWithRetries (
  prompt: string,
  model: any,
  maxRetries = 5
): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt)
      let text = result.response
        .text()
        .replace(/```json|```/g, '')
        .replace(/\r/g, '')
        .replace(/\u0000/g, '')
        .replace(/^[^{\[]+/, '')
        .trim()

      text = text.replace(/[\x00-\x1F\x7F]/g, (c: string) =>
        c === '\n' || c === '\t' ? c : ''
      )

      return JSON.parse(text)
    } catch (err) {
      console.warn(`Attempt ${attempt} failed to generate valid JSON:`, err)
      if (attempt === maxRetries)
        throw new Error(`Failed after ${maxRetries} attempts.`)
      await new Promise(res => setTimeout(res, 1000 * attempt))
    }
  }
}

wss.on('connection', ws => {
  console.log('✅ Client connected')

  ws.on('message', async message => {
    try {
      const {
        topic,
        userId,
        personalization = {}
      } = JSON.parse(message.toString())

      const {
        level = '',
        preferredTopics = '',
        dislikedTopics = '',
        goal = '',
        timeCommitment = '',
        learningStyle = ''
      } = personalization

      console.log('topic:', topic)
      console.log('userId:', userId)
      console.log('level', level)
      console.log('preferredTopics', preferredTopics)
      console.log('dislikedTopics', dislikedTopics)
      console.log('goal', goal)
      console.log('timeCommitment', timeCommitment, 'minutes')
      console.log('learningStyle', learningStyle)

      if (!topic || !userId) throw new Error('Missing topic or userId')

      const keyIndex = Math.floor(Math.random() * 23) + 1
      const envKey = `GEMINI_API_KEY_${keyIndex}`
      console.log(envKey)
      const selectedKey = process.env[envKey]

      if (!selectedKey) throw new Error(`Missing API key for ${envKey}`)

      const ai = new GoogleGenerativeAI(selectedKey)

      const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' })

      sendData({ ws, data: { step: 'syllabus', status: 'started' } })
      sendData({ ws, data: '📚 Generating syllabus...' })

      // ⚙️ Generate **personalized** syllabus prompt:
      const syllabusPrompt = getSyllabusPrompt({
        topic,
        level,
        preferredTopics,
        dislikedTopics,
        goal,
        timeCommitment,
        learningStyle
      })

      const syllabusJson = await generateValidJsonWithRetries(
        syllabusPrompt,
        model
      )

      const totalTimeMinutes = Number(timeCommitment) * 60
      const numberOfLessons = syllabusJson.lessons.length

      const lessonTimeTotal = totalTimeMinutes * 0.8 // 80% to lessons
      const quizTimeTotal = totalTimeMinutes * 0.2 // 20% to quizzes

      const lessonTimePerLesson = lessonTimeTotal / numberOfLessons
      const quizTimePerLesson = quizTimeTotal / numberOfLessons

      sendData({
        ws,
        data: { step: 'syllabus', status: 'completed', data: syllabusJson }
      })

      const lessons = []

      for (const lessonObj of syllabusJson.lessons) {
        const lessonTitle = lessonObj.title
        const lessonDuration = lessonObj.duration

        sendData({
          ws,
          data: {
            step: 'lesson',
            status: 'started',
            data: { title: lessonTitle }
          }
        })

        // ⚙️ Generate **personalized** context prompt:
        const contextPrompt = getLessonContextPrompt({
          lessonTitle,
          level,
          preferredTopics,
          dislikedTopics,
          goal,
          timeCommitment: lessonTimePerLesson.toString(),
          learningStyle
        })
        const context = await generateValidJsonWithRetries(contextPrompt, model)

        const sectionPrompt = getAllSectionsContentPrompt({
          context,
          level,
          preferredTopics,
          dislikedTopics,
          goal,
          timeCommitment: lessonTimePerLesson.toString(),
          learningStyle
        })
        const sectionContent = await generateValidJsonWithRetries(
          sectionPrompt,
          model
        )

        const allContentBlocks = []
        for (const section of sectionContent.sections) {
          for (const block of section.contentBlocks) {
            const contentBlock = {
              id: crypto.randomUUID(),
              order: block.order ?? 0,
              type: block.type,
              text: block.type === 'TEXT' ? block.content : undefined,
              code: block.type === 'CODE' ? block.content : undefined,
              math: block.type === 'MATH' ? block.content : undefined,
              graph: block.type === 'GRAPH' ? block.content : undefined
            }
            sendData({
              ws,
              data: {
                step: 'contentBlock',
                lessonTitle,
                sectionTitle: section.title,
                contentBlock
              }
            })
            allContentBlocks.push(contentBlock)
          }
        }

        const quizPrompt = getQuizPrompt({
          lessonTitle,
          contentBlocks: allContentBlocks,
          level,
          preferredTopics,
          dislikedTopics,
          goal,
          timeCommitment: quizTimePerLesson.toString(), // 👈 NEW VALUE
          learningStyle
        })
        const quizJson = await generateValidJsonWithRetries(quizPrompt, model)

        sendData({
          ws,
          data: { step: 'quiz', status: 'completed', data: quizJson }
        })

        lessons.push({
          lessonTitle,
          lessonDuration,
          context,
          allContentBlocks,
          quizJson
        })
      }

      sendData({ ws, data: '🗂️ Generating post-course content...' })

      const postCoursePrompt = getPostCourseDataPrompt({
        topic,
        level,
        preferredTopics,
        dislikedTopics,
        goal,
        timeCommitment,
        learningStyle
      })
      const postCourse = await generateValidJsonWithRetries(
        postCoursePrompt,
        model
      )

      sendData({ ws, data: '💾 Saving to database...' })

      const createdCourse = await db.course.create({
        data: {
          title: syllabusJson.title,
          description: syllabusJson.description,
          user: { connect: { id: userId } },
          lessons: {
            create: lessons.map((l, idx) => ({
              title: l.context.title,
              description: l.context.objective,
              duration: l.lessonDuration,
              order: idx,
              contentBlocks: {
                create: l.allContentBlocks.map((block, blockIdx) => ({
                  order: blockIdx + 1,
                  type: block.type,
                  text: block.text,
                  code: block.code,
                  math: block.math,
                  graph: block.graph
                }))
              },
              quizz: {
                create: {
                  title: l.context.title + ' Quiz',
                  duration: l.quizJson.duration,
                  totalMarks: l.quizJson.totalMarks,
                  passingMarks: l.quizJson.passingMarks,
                  isCompleted: false,
                  gainedMarks: 0,
                  timeTaken: 0,
                  questions: {
                    create: l.quizJson.questions.map((q: any) => ({
                      number: q.number,
                      question: q.question,
                      type: q.type,
                      options: q.options ?? [],
                      marks: q.marks,
                      correctAnswers: q.correctAnswers ?? [],
                      explanation: q.explanation ?? 'Explanation not provided.',
                      rubric: q.rubric ?? []
                    }))
                  }
                }
              }
            }))
          },
          summary: { create: postCourse.summary },
          keyPoints: { create: postCourse.keyPoints },
          analytics: { create: postCourse.analytics }
        }
      })

      sendData({ ws, data: { step: 'completed', courseId: createdCourse.id } })
      sendData({ ws, data: '✅ Course generation complete.' })
      ws.close()
    } catch (error) {
      console.error(error)
      sendData({
        ws,
        data: { step: 'error', message: '❌ Error generating course' }
      })
      ws.close()
    }
  })

  ws.on('close', () => console.log('❌ Client disconnected'))
})

function getSyllabusPrompt ({
  topic,
  level = '',
  preferredTopics = '',
  dislikedTopics = '',
  goal = '',
  timeCommitment = '',
  learningStyle = ''
}: {
  topic: string
  level?: string
  preferredTopics?: string
  dislikedTopics?: string
  goal?: string
  timeCommitment?: string
  learningStyle?: string
}) {
  return `
You are an expert educational content creator specializing in personalized learning design.

🎯 Your task is to generate a STRICTLY VALID JSON syllabus for the course topic: "${topic}".

⚙️ PERSONALIZATION GUIDELINES:
- Student Level: ${level || 'No preference provided'}
- Preferred Topics to Include: ${preferredTopics || 'None specified'}
- Topics to Avoid: ${dislikedTopics || 'None specified'}
- Learning Goal: ${goal || 'None specified'}
- Time Commitment: ${timeCommitment || 'No specific commitment provided'}
- Preferred Learning Style: ${learningStyle || 'No preference specified'}

Design the course content to match the learner’s background, interests, and available time. Avoid topics they dislike, emphasize those they prefer, and adjust the depth/difficulty accordingly.

⚠️ STRICT RULES:
- OUTPUT **STRICTLY VALID JSON**
- The response MUST start directly with '{' and end with '}'.
- **DO NOT** include explanations, introductions, markdown, comments, or code block syntax.
- **NO extra whitespace** outside the JSON.
- **NO null, undefined, or empty ("") fields.** If unknown, OMIT the field.
- All strings must be **double-quoted ("")**.
- Escape any special characters properly to maintain valid JSON.
- If you make a mistake in JSON, REPAIR IT before output.

📚 REQUIRED STRICT JSON FORMAT:
{
  "title": "Concise, compelling course title (relevant to topic & personalized preferences)",
  "description": "1-2 sentence explanation of what the course covers, aligned with user goal.",
  "lessons": [
    {
      "title": "Lesson Title (clear, engaging, no numbering like 'Lesson 1')",
      "duration": "e.g., '10 minutes' or '1 hour 15 minutes'"
    }
    // Add as many lessons as needed for a full personalized educational journey.
  ]
}

✅ EXAMPLE FORMAT (STRUCTURE ONLY — NOT CONTENT):
{
  "title": "Mastering Digital Marketing",
  "description": "Learn how to effectively promote products and services online using proven digital marketing strategies.",
  "lessons": [
    {
      "title": "Introduction to Digital Marketing",
      "duration": "10 minutes"
    },
    {
      "title": "SEO Basics for Website Optimization",
      "duration": "20 minutes"
    }
  ]
}

GENERATE a personalized, complete syllabus suitable for the learner’s profile.`
}

function getLessonContextPrompt ({
  lessonTitle,
  level = '',
  preferredTopics = '',
  dislikedTopics = '',
  goal = '',
  timeCommitment = '',
  learningStyle = ''
}: {
  lessonTitle: string
  level?: string
  preferredTopics?: string
  dislikedTopics?: string
  goal?: string
  timeCommitment?: string
  learningStyle?: string
}) {
  return `
You are an expert curriculum designer specializing in personalized education.

🎯 Your task is to generate a STRICTLY VALID JSON lesson object for the lesson titled: "${lessonTitle}".

⚙️ PERSONALIZATION GUIDELINES:
- Student Level: ${level || 'No preference provided'}
- Preferred Topics to Include: ${preferredTopics || 'None specified'}
- Topics to Avoid: ${dislikedTopics || 'None specified'}
- Learning Goal: ${goal || 'None specified'}
- Time Commitment: ${
    timeCommitment || 'No specific commitment provided'
  } Minutes
- Preferred Learning Style: ${learningStyle || 'No preference specified'}

Adapt the lesson content based on these preferences. Use simpler language and foundational concepts for beginners; provide deeper insights for advanced learners. Emphasize preferred topics, avoid disliked ones, and tailor the content length/depth to match time commitment and learning style.

⚠️ STRICT RULES:
- Output **STRICTLY VALID JSON**.
- The response MUST start directly with '{' and end with '}'.
- **NO** markdown, introductions, explanations, comments, or code blocks.
- **NO** empty strings, null, or undefined. If unknown, OMIT the field.
- **Strings must be double-quoted**.
- Properly escape special characters (e.g., use \" for quotes inside text).
- If JSON is invalid, **REPAIR** it before output.

📚 REQUIRED STRICT JSON FORMAT:
{
  "title": "${lessonTitle}",
  "objective": "One clear, concise learning objective describing what the learner will achieve after completing this lesson.",
  "sections": [
    {
      "title": "Clear, descriptive, and engaging section heading",
      "description": "1–2 sentence explanation of what this section covers, clearly contributing to the lesson’s objective."
    }
    // Add as many sections as necessary for complete understanding.
  ]
}

✅ STRUCTURE EXAMPLE (not content):
{
  "title": "Understanding Digital Marketing Funnels",
  "objective": "Understand how marketing funnels guide potential customers from awareness to conversion.",
  "sections": [
    {
      "title": "Introduction to Funnels",
      "description": "Learn what a marketing funnel is and why it’s important for guiding customer journeys."
    },
    {
      "title": "Stages of a Funnel",
      "description": "Explore each key stage in a funnel, from awareness to post-purchase engagement."
    }
  ]
}

Generate as many sections as necessary to ensure full learner understanding of the topic.`
}

function getAllSectionsContentPrompt ({
  context,
  level = '',
  preferredTopics = '',
  dislikedTopics = '',
  goal = '',
  timeCommitment = '',
  learningStyle = ''
}: {
  context: { title: string; objective: string }
  level?: string
  preferredTopics?: string
  dislikedTopics?: string
  goal?: string
  timeCommitment?: string
  learningStyle?: string
}) {
  return `
You are an expert lesson content creator.

🎯 Your task is to generate detailed educational content for ALL sections of the lesson titled: "${
    context.title
  }".

📖 Lesson Objective: "${context.objective}"

👤 Learner Profile (Personalization to strictly follow):
- Skill Level: ${level || 'General'}
- Preferred Topics: ${preferredTopics || 'None specified'}
- Topics to Avoid: ${dislikedTopics || 'None specified'}
- Goal: ${goal || 'None specified'}
- Time Commitment: ${timeCommitment || 'No specific time constraint'}
- Preferred Learning Style: ${learningStyle || 'None specified'}

⚠️ STRICT JSON ONLY — Follow these formatting instructions EXACTLY:

✅ The response MUST start directly with '{' and end with '}' — NO introductory text, NO explanation, NO markdown formatting.

✅ All property names and string values must be enclosed in double quotes ("").

✅ DO NOT omit commas between JSON fields, and DO NOT include trailing commas.

✅ Escape any embedded quotes properly with \" if necessary.

❗ If you are unable to generate the JSON properly for any reason, respond ONLY with {}.

📚 REQUIRED JSON FORMAT:
{
  "sections": [
    {
      "title": "Section Title",
      "contentBlocks": [
        {
          "type": "TEXT" | "CODE" | "MATH" | "GRAPH",
          "content": "Detailed content here OR structured object for GRAPH"
        }
      ]
    }
  ]
}

✅ STRICT FORMAT for "GRAPH" contentBlocks:
{
  "type": "GRAPH",
  "content": {
    "description": "Brief description of what the graph represents.",
    "xKey": "label or x-axis key name",
    "yKey": "value or y-axis key name",
    "data": [
      { "label": "Label for X-Axis", "value": Numeric or String for Y-Axis }
    ]
  }
}

⚙️ Content Guidelines:

- Generate clear, well-structured sections that progressively teach the learner.
- Each section MUST directly contribute to achieving the lesson objective.
- Tailor explanations to the specified skill level ("${level || 'General'}").
- Emphasize topics matching: ${preferredTopics || 'None'}.
- Avoid discussing topics related to: ${dislikedTopics || 'None'}.
- Adapt content to suit a "${learningStyle || 'general'}" learning style.
- If "Project-focused," include more practical examples.
- Adjust length/detail to fit the learner’s time commitment: "${
    timeCommitment || 'None'
  }".

📌 Example structure for GRAPH block (Do NOT include this example in the response!):
{
  "type": "GRAPH",
  "content": {
    "description": "Monthly revenue trend over Q1.",
    "xKey": "month",
    "yKey": "revenue",
    "data": [
      { "month": "January", "revenue": 5000 },
      { "month": "February", "revenue": 7000 }
    ]
  }
}

📢 NO introductions, NO markdown, NO extra whitespace, STRICT JSON ONLY.
If unsure or JSON generation fails, respond with '{}' ONLY.
`
}

function getQuizPrompt ({
  lessonTitle,
  contentBlocks,
  level = '',
  preferredTopics = '',
  dislikedTopics = '',
  goal = '',
  timeCommitment = '',
  learningStyle = ''
}: {
  lessonTitle: string
  contentBlocks: any[]
  level?: string
  preferredTopics?: string
  dislikedTopics?: string
  goal?: string
  timeCommitment?: string
  learningStyle?: string
}) {
  return `
You are an expert quiz generator with advanced knowledge of educational assessment and personalized learning.

🎯 Your task is to generate a STRICTLY VALID JSON quiz for the lesson titled: "${lessonTitle}".

👤 Learner Profile (USE THIS to tailor questions):
- Skill Level: ${level || 'General'}
- Preferred Topics: ${preferredTopics || 'None specified'}
- Topics to Avoid: ${dislikedTopics || 'None specified'}
- Goal: ${goal || 'None specified'}
- Time Commitment: ${timeCommitment || 'None specified'} Minutes
- Preferred Learning Style: ${learningStyle || 'None specified'}

📖 Lesson Content (REFERENCE ONLY — DO NOT INCLUDE in response):
${JSON.stringify(contentBlocks)}

⚠️ STRICT JSON ONLY RULES:

✅ Response MUST start directly with '{' and end with '}'.
✅ DO NOT include markdown, explanations, or ANY introductory text.
✅ All property names and string values MUST be enclosed in double quotes ("").
✅ Escape embedded quotes (e.g., use \\" inside strings).
✅ DO NOT include null, undefined, or empty string ("") values. OMIT unknowns.
✅ DO NOT include trailing commas.
✅ If you CANNOT generate strictly valid JSON, respond ONLY with '{}'.

📚 REQUIRED JSON STRUCTURE:

{
  "title": "Quiz for ${lessonTitle}",
  "duration": "10 minutes",
  "totalMarks": 50,
  "passingMarks": 30,
  "status": "NOT_STARTED",
  "questions": [
    {
      "number": 1,
      "question": "Clear, concise question directly based on the lesson content.",
      "type": "MCQ" | "MULTIPLE_SELECT" | "DESCRIPTIVE" | "TRUE_FALSE",
      "options": ["A", "B", "C", "D"],                // REQUIRED for MCQ & MULTIPLE_SELECT only
      "marks": 10,
      "correctAnswers": ["A"],                        // REQUIRED for all EXCEPT DESCRIPTIVE
      "explanation": "Short explanation of why the answer is correct.",  // REQUIRED for all EXCEPT DESCRIPTIVE
      "rubric": ["Point 1", "Point 2"]                // REQUIRED for DESCRIPTIVE only
    }
  ]
}

✅ Quiz Requirements:

- Generate **5–8** questions relevant to the lesson content.
- Adjust difficulty based on learner **skill level**: 
  ➔ Beginner → simpler, foundational.
  ➔ Advanced → deeper, more analytical.
- If learning style is **Project-focused**, include practical application-based questions.
- **Avoid** generating questions related to "${
    dislikedTopics || 'None specified'
  }".
- Balance MCQ, MULTIPLE_SELECT, TRUE_FALSE, and DESCRIPTIVE.
- Provide plausible **4 options** for MCQ/MULTIPLE_SELECT.
- Include **rubric** for DESCRIPTIVE with at least 2 points.
- **Total marks MUST equal 50.**
- Ensure clear explanations for every answer (except DESCRIPTIVE).
- Questions MUST be sequentially numbered starting from 1.
- Prefer diversity in complexity — mix easy, medium, hard.

🔒 STRICT VALID JSON ONLY. Begin generating if fully understood.
`
}

function getPostCourseDataPrompt ({
  topic,
  level = '',
  preferredTopics = '',
  dislikedTopics = '',
  goal = '',
  timeCommitment = '',
  learningStyle = ''
}: {
  topic: string
  level?: string
  preferredTopics?: string
  dislikedTopics?: string
  goal?: string
  timeCommitment?: string
  learningStyle?: string
}) {
  return `
You are an expert educational analyst and instructional designer.

🎯 Your task is to generate a STRICTLY VALID JSON object representing the **summary**, **key points**, and **analytics** for the personalized course titled: "${topic}".

👤 Learner Profile (USE THIS to tailor your output):
- Skill Level: ${level || 'General'}
- Preferred Topics: ${preferredTopics || 'None specified'}
- Topics to Avoid: ${dislikedTopics || 'None specified'}
- Goal: ${goal || 'None specified'}
- Time Commitment: ${timeCommitment || 'None specified'}
- Preferred Learning Style: ${learningStyle || 'None specified'}

⚠️ STRICT JSON FORMAT ONLY. Follow these rules:

✅ The response MUST start directly with '{' and end with '}'.
✅ DO NOT include any explanations, markdown formatting, or introductory text.
✅ All property names and string values MUST be enclosed in double quotes ("").
✅ DO NOT omit commas. DO NOT include trailing commas.
✅ Escape embedded quotes properly (use \\" inside strings).
✅ If you cannot generate valid JSON, respond ONLY with '{}'.

📚 REQUIRED JSON STRUCTURE:

{
  "summary": {
    "overview": "2-3 sentence summary of the course tailored to the learner’s ${
      goal || 'overall learning objective'
    }.",
    "whatYouLearned": ["Concept 1", "Concept 2", "Concept 3"],
    "skillsGained": ["Skill 1", "Skill 2", "Skill 3"],
    "nextSteps": ["Recommended next topic 1", "Recommended next topic 2"]
  },
  "keyPoints": [
    {
      "category": "e.g., Core Concepts, Best Practices, Tools Used",
      "points": ["Important point 1", "Important point 2", "Important point 3"]
    }
  ],
  "analytics": {
    "timeSpentTotal": float,            // e.g., 120.5
    "timeSpentLessons": float,          // e.g., 90.0
    "timeSpentQuizzes": float,          // e.g., 30.5
    "averageScore": float,              // e.g., 80.0 (should match with grade realistically)
    "totalQuizzes": integer,            // e.g., 5
    "passedQuizzes": integer,           // e.g., 4
    "grade": "EXCELLENT" | "GOOD" | "AVERAGE" | "NEEDS_IMPROVEMENT",
    "lessonsCompleted": integer,        // e.g., 10
    "quizzesCompleted": integer,        // e.g., 5
    "totalLessons": integer             // e.g., 10
  }
}

✅ Generation Guidelines:

- Tailor the **overview**, **whatYouLearned**, **skillsGained**, and **nextSteps** based on the **goal**, **level**, and **learningStyle**.
- Avoid mentioning "${dislikedTopics || 'None'}".
- "nextSteps" should suggest relevant follow-up courses/topics aligned with ${
    goal || 'the learner’s learning objectives'
  }.
- "analytics" values MUST be realistic and coherent:
  ➔ timeSpentTotal = timeSpentLessons + timeSpentQuizzes
  ➔ averageScore should realistically correspond with grade:
     EXCELLENT → 85–100
     GOOD → 70–85
     AVERAGE → 50–70
     NEEDS_IMPROVEMENT → <50
- Use **float** values for time durations (e.g., 120.5), NOT strings.
- All arrays must have at least 2–3 items where applicable.
- Ensure that **"grade"** is logically consistent with **"averageScore"**.

🔒 STRICT VALID JSON ONLY. Begin generating the JSON if fully understood.
`
}
