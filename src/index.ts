import WebSocket, { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { db } from './db' // Ensure this imports Prisma properly

dotenv.config()

const PORT = Number(process.env.PORT) || 3001
const TOTAL_KEYS = 24
const MAX_RETRIES = 5

const wss = new WebSocketServer({ port: PORT })
console.log(`✅ WebSocket server running at ws://localhost:${PORT}`)

function sendData ({ ws, data }: { ws: WebSocket; data: unknown }) {
  ws.send(JSON.stringify(data))
}

function getRandomApiKey (): string {
  const keyIndex = Math.floor(Math.random() * TOTAL_KEYS) + 1
  const envKey = `GEMINI_API_KEY_${keyIndex}`
  const selectedKey = process.env[envKey]
  if (!selectedKey) throw new Error(`Missing API key for ${envKey}`)
  return selectedKey
}

async function generateValidJsonWithRetries (
  prompt: string,
  model: any,
  maxRetries = MAX_RETRIES
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
        .replace(/[\x00-\x1F\x7F]/g, (c: string) =>
          c === '\n' || c === '\t' ? c : ''
        )
        .trim()
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

      if (!topic || !userId) throw new Error('Missing topic or userId')

      const ai = new GoogleGenerativeAI(getRandomApiKey())
      const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' })

      sendData({ ws, data: { step: 'syllabus', status: 'started' } })
      sendData({ ws, data: '📚 Generating syllabus...' })

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
      const lessonTimePerLesson = (totalTimeMinutes * 0.8) / numberOfLessons
      const quizTimePerLesson = (totalTimeMinutes * 0.2) / numberOfLessons

      sendData({
        ws,
        data: { step: 'syllabus', status: 'completed', data: syllabusJson }
      })

      const lessons = []

      for (const lessonObj of syllabusJson.lessons) {
        const { title: lessonTitle, duration: lessonDuration } = lessonObj

        sendData({
          ws,
          data: {
            step: 'lesson',
            status: 'started',
            data: { title: lessonTitle }
          }
        })

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
          timeCommitment: quizTimePerLesson.toString(),
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

function getSyllabusPrompt({
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
You are a highly specialized curriculum designer for personalized learning programs.

🔐 Your task is to generate a **STRICTLY VALID JSON** syllabus for the course titled **"${topic}"** tailored to the user's preferences.

📌 **Learner Profile**:
- Skill Level: ${level || 'General'}
- Topics to Emphasize: ${preferredTopics || 'None specified'}
- Topics to Avoid: ${dislikedTopics || 'None specified'}
- Learning Goal: ${goal || 'None specified'}
- Total Time Commitment: ${timeCommitment || 'Flexible'}
- Preferred Learning Style: ${learningStyle || 'None specified'}

⚠️ **ABSOLUTE RULES**:
- OUTPUT MUST BE **STRICT VALID JSON**
- DO NOT include any explanation, markdown, or extra characters outside of the JSON object.
- JSON **MUST** start with '{' and end with '}'.
- No null, undefined, or empty ("") values — omit unknowns.
- All keys and string values **must** be enclosed in double quotes.
- Escape internal double quotes properly: \"

🎨 **STRUCTURE**:
{
  "title": "Concise, engaging course title (relevant to topic & user preferences)",
  "description": "1–2 sentence overview aligned to the learner’s goals.",
  "lessons": [
    {
      "title": "Lesson Title (engaging, specific, NOT 'Lesson 1')",
      "duration": "e.g., '10 minutes', '45 minutes', or '1 hour 30 minutes'"
    }
  ]
}

✅ If JSON generation fails for any reason, respond ONLY with '{}'.
`
}

function getLessonContextPrompt({
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
You are a curriculum architect creating **STRICTLY VALID JSON** for a lesson titled "${lessonTitle}".

📌 **Learner Profile**:
- Skill Level: ${level || 'General'}
- Preferred Topics: ${preferredTopics || 'None specified'}
- Topics to Avoid: ${dislikedTopics || 'None specified'}
- Goal: ${goal || 'None specified'}
- Available Time: ${timeCommitment || 'Flexible'}
- Learning Style: ${learningStyle || 'General'}

⚠️ **STRICT JSON RULES**:
- Response MUST start with '{' and end with '}' — NOTHING ELSE.
- NO markdown, explanations, code fences, or comments.
- OMIT empty or unknown values.
- Strings MUST be double-quoted, and embedded quotes properly escaped.

📚 **STRUCTURE**:
{
  "title": "${lessonTitle}",
  "objective": "One clear, specific outcome describing what the learner will accomplish.",
  "sections": [
    {
      "title": "Engaging section title (clear, concise)",
      "description": "Brief explanation of what the section covers."
    }
  ]
}

✅ If JSON generation fails, respond ONLY with '{}'.
`
}

function getAllSectionsContentPrompt({
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
You are a specialized educational content writer generating **STRICTLY VALID JSON** for the sections of the lesson "${context.title}".

🎯 Lesson Objective: "${context.objective}"

📌 **Learner Profile**:
- Skill Level: ${level || 'General'}
- Emphasize Topics: ${preferredTopics || 'None'}
- Avoid Topics: ${dislikedTopics || 'None'}
- Goal: ${goal || 'None'}
- Time Commitment: ${timeCommitment || 'Flexible'}
- Learning Style: ${learningStyle || 'General'}

⚠️ **STRICT JSON RULES**:
- DO NOT include markdown, explanations, or code syntax.
- Output MUST start with '{' and end with '}'.
- OMIT empty or unknown values.
- Strings MUST be double-quoted. Escape special characters correctly.
- Proper JSON structure with NO extra whitespace.

📚 **STRUCTURE**:
{
  "sections": [
    {
      "title": "Section Title",
      "contentBlocks": [
        {
          "type": "TEXT" | "CODE" | "MATH" | "GRAPH",
          "content": "Detailed content or structured object for GRAPH type"
        }
      ]
    }
  ]
}

✅ **GRAPH FORMAT Example (structure only)**:
{
  "type": "GRAPH",
  "content": {
    "description": "Brief description of the graph.",
    "xKey": "X-axis label",
    "yKey": "Y-axis label",
    "data": [
      { "label": "Label", "value": NumericValue }
    ]
  }
}

If JSON generation fails or you’re unsure, return '{}' ONLY.
`
}

function getQuizPrompt({
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
You are an expert educational assessment designer.

🎯 Your task is to generate a **STRICTLY VALID JSON** quiz for the lesson titled: "${lessonTitle}".

📌 **Learner Profile (FOLLOW STRICTLY):**
- Skill Level: ${level || 'General'}
- Emphasize Topics: ${preferredTopics || 'None specified'}
- Avoid Topics: ${dislikedTopics || 'None specified'}
- Goal: ${goal || 'None specified'}
- Available Time: ${timeCommitment || 'Flexible'}
- Learning Style: ${learningStyle || 'None specified'}

📖 Lesson Content (REFERENCE ONLY, DO NOT INCLUDE IN RESPONSE):
${JSON.stringify(contentBlocks)}

⚠️ **ABSOLUTE JSON RULES**:
- OUTPUT MUST start directly with '{' and end with '}'.
- OMIT markdown, explanations, introductory text, comments, or code fences.
- OMIT empty or unknown values.
- Strings MUST use double quotes. Escape embedded quotes properly: \\".
- Trailing commas are NOT allowed.
- If JSON generation fails, respond ONLY with '{}'.

📚 **REQUIRED JSON FORMAT**:
{
  "title": "Quiz for ${lessonTitle}",
  "duration": "10 minutes",
  "totalMarks": 50,
  "passingMarks": 30,
  "status": "NOT_STARTED",
  "questions": [
    {
      "number": 1,
      "question": "Clear, concise question based on the lesson content.",
      "type": "MCQ" | "MULTIPLE_SELECT" | "DESCRIPTIVE" | "TRUE_FALSE",
      "options": ["Option A", "Option B", "Option C", "Option D"],  // REQUIRED for MCQ & MULTIPLE_SELECT ONLY
      "marks": 10,
      "correctAnswers": ["A"],                                      // REQUIRED for ALL except DESCRIPTIVE
      "explanation": "Short explanation of the correct answer.",    // REQUIRED for ALL except DESCRIPTIVE
      "rubric": ["Point 1", "Point 2"]                              // REQUIRED for DESCRIPTIVE ONLY
    }
  ]
}

✅ **Quiz Requirements**:
- **5 to 8 questions** covering a mix of concepts, difficulty levels, and question types.
- **Types:**
  - MCQ → 4 plausible, distinct options.
  - MULTIPLE_SELECT → 4 plausible options, multiple correct.
  - TRUE_FALSE → Must be clearly True or False.
  - DESCRIPTIVE → Include rubric (minimum 2 points) for grading.
- Total Marks MUST equal 50.
- Number questions sequentially starting at 1.
- Adjust difficulty based on learner’s **skill level**.
- Avoid questions related to: ${dislikedTopics || 'None specified'}.
- Explanations REQUIRED for all except DESCRIPTIVE.
- Provide **practical application-based** questions if the learning style is "Project-focused".
- Questions MUST vary in complexity (easy → medium → hard).

🔐 **STRICT VALID JSON ONLY.** Respond with '{}' if unsure.
`
}


function getPostCourseDataPrompt({
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

🎯 Your task is to generate a **STRICTLY VALID JSON** object for the **summary**, **key points**, and **analytics** of the personalized course titled: "${topic}".

📌 **Learner Profile:**
- Skill Level: ${level || 'General'}
- Emphasize Topics: ${preferredTopics || 'None specified'}
- Avoid Topics: ${dislikedTopics || 'None specified'}
- Goal: ${goal || 'None specified'}
- Available Time: ${timeCommitment || 'Flexible'}
- Learning Style: ${learningStyle || 'None specified'}

⚠️ **STRICT JSON FORMAT RULES**:
- MUST start with '{' and end with '}' — NO other output allowed.
- NO markdown, explanations, or introductory text.
- OMIT empty or unknown values.
- All property names and string values must be double-quoted.
- Escape embedded quotes properly using \\".
- NO trailing commas.
- If JSON generation fails or is uncertain, respond ONLY with '{}'.

📚 **REQUIRED JSON STRUCTURE**:
{
  "summary": {
    "overview": "2–3 sentences summarizing the course tailored to the learner’s ${goal || 'learning objective'}.",
    "whatYouLearned": ["Concept 1", "Concept 2", "Concept 3"],
    "skillsGained": ["Skill 1", "Skill 2", "Skill 3"],
    "nextSteps": ["Recommended topic 1", "Recommended topic 2"]
  },
  "keyPoints": [
    {
      "category": "e.g., Core Concepts, Best Practices, Tools Used",
      "points": ["Key point 1", "Key point 2", "Key point 3"]
    }
  ],
  "analytics": {
    "timeSpentTotal": float,            // = timeSpentLessons + timeSpentQuizzes (e.g., 120.5)
    "timeSpentLessons": float,          // (e.g., 90.0)
    "timeSpentQuizzes": float,          // (e.g., 30.5)
    "averageScore": float,              // (e.g., 85.0)
    "totalQuizzes": integer,            // (e.g., 5)
    "passedQuizzes": integer,           // (e.g., 4)
    "grade": "EXCELLENT" | "GOOD" | "AVERAGE" | "NEEDS_IMPROVEMENT",
    "lessonsCompleted": integer,        // (e.g., 10)
    "quizzesCompleted": integer,        // (e.g., 5)
    "totalLessons": integer             // (e.g., 10)
  }
}

✅ **Generation Guidelines**:
- Overview must reflect **goal** or general learning purpose.
- Avoid mentioning: ${dislikedTopics || 'None'}.
- nextSteps → Recommend relevant follow-up learning paths.
- **Grade/averageScore correlation:**
  - EXCELLENT → 85–100
  - GOOD → 70–85
  - AVERAGE → 50–70
  - NEEDS_IMPROVEMENT → Below 50
- Use **float** numbers for time metrics; **integers** for counts.
- Arrays for **whatYouLearned**, **skillsGained**, and **nextSteps** should each have **at least 2–3** items.
- Ensure that **timeSpentTotal = timeSpentLessons + timeSpentQuizzes**.

🔐 **STRICT VALID JSON ONLY.** Respond with '{}' if unsure.
`
}
