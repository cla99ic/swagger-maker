#!/usr/bin/env node

let fs, path, yaml, m2s
let mode = 'commonjs'
if (typeof exports !== 'undefined' && typeof module !== 'undefined' && module.exports) {
    // CommonJS mode
    fs = require('fs')
    path = require('path')
    yaml = require('js-yaml')
    m2s = require('mongoose-to-swagger')
} else {
    // ECMAScript module mode
    mode = 'module'
    import('fs').then(a => {
        fs = a
    })
    import('path').then(a => {
        path = a
    })
    import('js-yaml').then(a => {
        yaml = a
    })
    import('mongoose-to-swagger').then(a => {
        m2s = a.default
    })
}


const convertToSwaggerSchema = jsonObj => {
    return Object.fromEntries(
        Object.entries(jsonObj).map(([key, value]) => {
            if (Array.isArray(value)) {
                if (value.length > 0 && typeof value[0] === 'object') {
                    const arrayItemSchema = {
                        type: 'object',
                        properties: convertToSwaggerSchema(value[0] || {}),
                    }
                    return [key, { type: 'array', items: arrayItemSchema }]
                }
                return [key, { type: 'array', items: { type: typeof value[0] } }]
            }
            if (typeof value === 'object') {
                return [key, { type: 'object', properties: convertToSwaggerSchema(value) }]
            }
            return [key, { type: typeof value }]
        })
    )
}

const convert = str => {
    const result = str.replace(/\b(\w+)\b/g, '"$1"')
    return JSON.parse(result)
}

const listFiles = folderPath => {
    return fs.readdirSync(folderPath).reduce((allFiles, file) => {
        const filePath = path.join(folderPath, file)
        return allFiles.concat(
            fs.statSync(filePath).isDirectory() ? listFiles(filePath) : filePath
        )
    }, [])
}

const scan = async () => {
    while (!fs || !path || !yaml || !m2s) await new Promise(resolve => setTimeout(resolve, 5))

    // config: defaultkey title version
    let routerDirectoryPath = path.join(process.cwd(), 'src', 'router')
    let schemaDirectoryPath = path.join(process.cwd(), 'dist', 'src', 'model')
    let outputDirectory = path.join(process.cwd(), 'swagger')
    let routerObjectName = 'router'
    let title = 'Sample API'
    let version = '1.0.0'
    if (fs.existsSync('swaggerconfig.json')) {
        try {
            const config = JSON.parse(fs.readFileSync('swaggerconfig.json'))
            if ('router' in config) routerDirectoryPath = path.join(process.cwd(), config['router'])
            if ('model' in config) schemaDirectoryPath = path.join(process.cwd(), config['model'])
            if ('output' in config) outputDirectory = path.join(process.cwd(), config['output'])
            if ('routerObject' in config) routerObjectName = config.router
            if ('title' in config) title = config.title
            if ('version' in config) version = config.version
        } catch (e) { }
    }
    if (process.argv.length > 2) {
        for (let i = 2; i < process.argv.length; i += 2) {
            const arg = process.argv[i]
            const value = process.argv[i + 1]
            switch (arg) {
                case '--router':
                    if (value) routerDirectoryPath = path.join(process.cwd(), value)
                    break
                case '--model':
                    if (value) schemaDirectoryPath = path.join(process.cwd(), value)
                    break
                case '--output':
                    if (value) outputDirectory = path.join(process.cwd(), value)
                    break
                case '--routerObject':
                    if (value) routerObjectName = value
                    break
                case '--title':
                    if (value) title = value
                    break
                case '--version':
                    if (value) version = value
                    break
            }
        }
    }
    let tempDirectory = outputDirectory + '2'


    if (!fs.existsSync(tempDirectory, 'component'))
        fs.mkdirSync(path.join(tempDirectory, 'component'), { recursive: true })

    if (!fs.existsSync(path.join(tempDirectory, 'router')))
        fs.mkdirSync(path.join(tempDirectory, 'router'), { recursive: true })
    for (let schemaFile of listFiles(schemaDirectoryPath)) {
        try {
            let model
            try {
                model = require(schemaFile).default
            } catch (e) {
                //schemaFile.replace(process.cwd(), '.').replace(/\\/g, '/')
                model = (await import('file://' + schemaFile)).default
            }
            const swaggerSchema = m2s(model)
            const swaggerFilePath = path.join(tempDirectory, 'component', schemaFile.replace(schemaDirectoryPath, '').replace(/\.[^.\\]+$/, '.yaml'))

            if (!fs.existsSync(path.dirname(swaggerFilePath)))
                fs.mkdirSync(path.dirname(swaggerFilePath), { recursive: true })

            let yamlData = {}

            if (fs.existsSync(swaggerFilePath)) {
                yamlData = yaml.load(fs.readFileSync(swaggerFilePath).toString())
            }

            yamlData[swaggerSchema.title + '-default'] = swaggerSchema
            fs.writeFileSync(swaggerFilePath, yaml.dump(yamlData))

        } catch (e) {
            const errorMessage = e.message
        }
    }

    const mainObject = {
        openapi: '3.1.0',
        info: {
            title,
            version,
        },
        components: {
            securitySchemes: {
                jwt: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        paths: {},
    }

    for (let routerFile of listFiles(routerDirectoryPath)) {
        let swaggerFilePath = path.join(tempDirectory, 'router', routerFile.replace(routerDirectoryPath, ''))
        swaggerFilePath = path.join(
            path.dirname(swaggerFilePath),
            path.basename(swaggerFilePath, path.extname(swaggerFilePath)) + '.yaml'
        )

        const rawContent = fs.readFileSync(routerFile).toString()
        if (!rawContent.includes(`${routerObjectName}.`)) continue
        const endpointsData = rawContent.split(`${routerObjectName}.`)
        let fileObject = {}

        for (let i = 1; i < endpointsData.length; i++) {
            const endpointData = endpointsData[i]

            if (
                endpointsData[i - 1].trim().endsWith('//') ||
                endpointsData[i - 1].trim().endsWith('/*')
            ) {
                continue
            }

            const method = endpointData.split('(')[0]
            const endpoint = endpointData.split('\'')[1].split('\'')[0].replace(/:(\w+)/g, '{$1}')
            let editedEndpoint = endpoint.replace(/\//g, '-')

            if (editedEndpoint.startsWith('-')) editedEndpoint = editedEndpoint.substring(1)

            let api = {
                parameters: [],
                responses: {},
            }

            const regex = /\/:([^/]+)/g
            const matches = endpoint.match(regex)

            if (matches) {
                matches
                    .map(match => match.slice(2))
                    .forEach(param =>
                        api.parameters.push({
                            name: param,
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                        })
                    )
            }

            const auth = endpointData.split('(req')[0].includes('auth(')

            if (auth) api.security = [{ jwt: [] }]

            if (endpointsData[i - 1].includes('/**')) {
                const occurrenceCount = (endpointsData[i - 1].match(new RegExp('/\\*\\*', 'g')) || []).length
                const annotations = endpointsData[i - 1].split('/**')[occurrenceCount].split('*/')[0]

                if (annotations.includes('@ignore')) continue

                if (annotations.includes('@manual') && fs.existsSync(swaggerFilePath)) {
                    const yamlData = yaml.load(fs.readFileSync(swaggerFilePath).toString())

                    if (yamlData['paths'] && yamlData['paths'][editedEndpoint] && yamlData['paths'][editedEndpoint][method]) {
                        api = yamlData['paths'][editedEndpoint][method]

                        if (editedEndpoint in fileObject)
                            fileObject[editedEndpoint][method] = api
                        else {
                            fileObject[editedEndpoint] = { [method]: api }
                            let ref = routerFile
                                .replace(routerDirectoryPath, '')
                                .replace(/\\/g, '/')
                                .replace(/\.[^.\\]+$/, '.yaml')

                            mainObject.paths[endpoint] = { $ref: `./router${ref}#/paths/` + editedEndpoint }
                        }

                        continue
                    }
                }

                if (annotations.includes('@description'))
                    api.description = annotations.split('@description')[1].split('\n')[0].trim()

                if (annotations.includes('@summary'))
                    api.summary = annotations.split('@summary')[1].split('\n')[0].trim()

                if (annotations.includes('@queries'))
                    annotations
                        .split('@queries')[1]
                        .split('\n')[0]
                        .trim()
                        .split(',')
                        .forEach(a =>
                            api.parameters.push({
                                name: a.split(':')[0].trim(),
                                description: (a.split(':')[1] || '').trim(),
                                in: 'query',
                                required: false,
                                schema: { type: 'string' },
                            })
                        )

                if (annotations.includes('@body')) {
                    let body = annotations.split('@body')[1].split('\n')[0].trim()

                    if (body.startsWith('{')) {
                        body = convert(body)
                        body = convertToSwaggerSchema(body)
                        api.requestBody = {
                            required: true,
                            content: {
                                'application/json': { schema: { type: 'object', properties: body } },
                            },
                        }
                    } else {
                        api.requestBody = {
                            required: true,
                            content: { 'application/json': { schema: { $ref: body } } },
                        }
                    }
                }

                if (annotations.includes('@response')) {
                    let response = annotations.split('@response')[1].split('\n')[0].trim()

                    if (response.startsWith('{')) {
                        response = convert(response)
                        response = convertToSwaggerSchema(response)
                        api.responses = {
                            200: {
                                description: 'Successful response',
                                content: { 'application/json': { schema: { type: 'object', properties: response } } },
                            },
                        }
                    } else {
                        api.responses = {
                            200: { description: 'Successful response', content: { 'application/json': { schema: response } } },
                        }
                    }
                }
            }

            if (editedEndpoint in fileObject)
                fileObject[editedEndpoint][method] = api
            else {
                fileObject[editedEndpoint] = { [method]: api }
                let ref = routerFile.replace(routerDirectoryPath, '').replace(/\\/g, '/').replace(/\.[^.\\]+$/, '.yaml')

                mainObject.paths[endpoint] = { $ref: `./router${ref}#/paths/` + editedEndpoint }
            }
        }

        if (!fs.existsSync(path.dirname(swaggerFilePath)))
            fs.mkdirSync(path.dirname(swaggerFilePath), { recursive: true })

        fileObject = { paths: fileObject }
        const yamlData = yaml.dump(fileObject)
        fs.writeFileSync(swaggerFilePath, yamlData)
    }

    const yamlData = yaml.dump(mainObject)
    fs.writeFileSync('./swagger2/swagger.yaml', yamlData)
    fs.rmSync('./swagger', { recursive: true, force: true })
    fs.renameSync('./swagger2', './swagger')
    process.exit()
}

scan()
