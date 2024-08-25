'use strict';

function addAliases(aliases, compiledResources, activeAliasName) {
  const functionEntries = getResources(compiledResources, 'AWS::Lambda::Function');

  // Get the lambdaVersion resources as an entries-array, to make searching easier
  const lambdaVersionEntries = getResources(compiledResources, 'AWS::Lambda::Version');

  const functionNames = functionEntries.map((f) => f[0]);

  // Create an Alias for each function first. This is required regardless of whether the function
  // has an HTTP event or not.
  const aliasConfig = functionNames
    .map((lambdaName) => {
      // Try to find the corresponding LambaVersion resource for this Lambda name.
      // If it does not exist, don't create the alias
      const functionVersion = getActualFunctionVersion(lambdaName, lambdaVersionEntries);

      if (!functionVersion) {
        return;
      }

      // Loop over the aliases and return an object
      return aliases.reduce((acc, alias, index) => {
        acc[`${lambdaName}Alias${alias === activeAliasName ? '' : index}`] = {
          Type: 'AWS::Lambda::Alias',
          Properties: {
            Name: alias.replace(/[^\w-_]/g, '-'),
            FunctionName: {
              'Fn::GetAtt': [lambdaName, 'Arn'],
            },
            FunctionVersion: functionVersion,
          },
          DependsOn: [lambdaName],
        };
        return acc;
      }, {});
    })
    .filter((item) => Boolean(item))
    .reduce((acc, curr) => ({ ...acc, ...curr }), {}); // Flatten the array back to an object;

  return aliasConfig;
}

/**
 * Adds the active alias to the API Gateway configuration for each HTTP event-trigger for each Lambda.
 *
 * This code expects the Serverless HTTP configuration to look like this:
 *
 * functions: {
 *   getLambdas: { // REQUIRED
 *     handler: 'src/handlers/getLambdas.handler',
 *     description: 'Get a list of lambdas and their versions',
 *     events: [
 *       {
 *         http: {
 *           method: 'GET', // REQUIRED for HTTP events
 *           path: 'deployment/lambdas', // REQUIRED for HTTP events
 *         },
 *       },
 *     ],
 *   },
 * ...
 *
 * If there is no HTTP trigger, or it is specified in an abbreviated format, this code will not work.
 *
 * @param activeAliasName {string}
 * @param compiledResources {*[]}
 * @return {*}
 */
function addAPIGatewayConfig(activeAliasName, compiledResources) {
  // Get the list of ApiGateway Methods to modify with the active alias
  // Filter the apiGatewayMethods so that we only modify ones with Properties.Integration.Type = AWS_PROXY
  const apiGatewayMethodsV1 = getResources(compiledResources, 'AWS::ApiGateway::Method').filter(
    ([, resource]) => resource.Properties.Integration.Type === 'AWS_PROXY'
  );

  const apiGatewayIntegrationsV2 = getResources(compiledResources, 'AWS::ApiGatewayV2::Integration').filter(
    ([, resource]) => resource.Properties.IntegrationType === 'AWS_PROXY'
  );

  // Modify the API Gateway method to add the alias to the Integration Uri
  applyAPIGatewayConfigV1(apiGatewayMethodsV1, activeAliasName, compiledResources);
  applyAPIGatewayConfigV2(apiGatewayIntegrationsV2, compiledResources);

  // Update the Lambda permissions to point to the FunctionAlias
  const lambdaPermissions = getResources(compiledResources, 'AWS::Lambda::Permission');

  lambdaPermissions.forEach(([resourceName, resource]) => {
    // FIX APPLIED: lambda permission may not be a function always, but may refer to an ARN of an existing AWS function
    // e.g for existing authorizers in functions referred with ARN, permission is still created to allow API Gateway
    // to invoke the authorizer function which may be existing in AWS and not be part of this service
    // and then FunctionName: { 'Fn::GetAtt': [ 'SomeFunctionName', 'Arn' ] },
    // will be FunctionName: arn:....
    if (!resource.Properties.FunctionName['Fn::GetAtt']) {
      return;
    }

    // Get the existing function name from the resource, then use it to refer to the alias-resource
    const existingLambdaName = resource.Properties.FunctionName['Fn::GetAtt'][0];

    if (!existingLambdaName.includes('Alias')) {
      compiledResources[resourceName].Properties.FunctionName = {
        Ref: `${existingLambdaName}Alias`,
      };
      compiledResources[resourceName].DependsOn = [`${existingLambdaName}Alias`];
    }
  });

  return compiledResources;
}

function getResources(compiledResources, type) {
  return Object.entries(compiledResources).filter(([, resource]) => resource.Type === type);
}

function getActualFunctionVersion(arn, lambdaVersionResourceEntries) {
  const key = getFunctionKey(arn, lambdaVersionResourceEntries);
  return key && { 'Fn::GetAtt': [key, 'Version'] };
}

function getFunctionKey(arn, lambdaVersionResourceEntries) {
  const [key] = lambdaVersionResourceEntries.find(([, resource]) => resource.Properties.FunctionName.Ref === arn) || [];
  return key;
}

function applyAPIGatewayConfigV1(apiGatewayMethods, activeAliasName, compiledResources) {
  apiGatewayMethods.forEach(([resourceName, resource]) => {
    let integrationUriArr = resource.Properties.Integration.Uri['Fn::Join'][1];
    integrationUriArr[integrationUriArr.length - 1] = `:${activeAliasName}/invocations`;
    compiledResources[resourceName] = resource;
  });
}

function applyAPIGatewayConfigV2(apiGatewayIntegrations, compiledResources) {
  apiGatewayIntegrations.forEach(([resourceName]) => {
    compiledResources[resourceName].Properties.IntegrationUri['Fn::GetAtt'][0] += 'Alias';
    compiledResources[resourceName].Properties.IntegrationUri['Fn::GetAtt'][1] = 'AliasArn';
  });
}

module.exports = {
  addAliases,
  addAPIGatewayConfig,
};
