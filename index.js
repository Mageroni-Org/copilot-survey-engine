/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */

const dedent = require('dedent');
const fs = require('fs');
const path = require("path");
const sql = require("mssql");
require('dotenv').config();
let comment = null;

const { TextAnalysisClient, AzureKeyCredential } = require("@azure/ai-language-text");
const { KEY, ENDPOINT, ConnString } = process.env;

module.exports = (app) => {
  // Your code here
  app.log.info("Yay, the app was loaded!");

  let appInsights = require('applicationinsights');
  appInsights.setup().start();
  let appIClient = appInsights.defaultClient;

  app.on("pull_request.closed", async (context) => {
    appIClient.trackEvent({name: "Pull Request Close Payload", properties: context.payload});
    let pr_number = context.payload.pull_request.number;
    let pr_body = context.payload.pull_request.body;
    
    // check language for pr_body
    const TAclient = new TextAnalysisClient(ENDPOINT, new AzureKeyCredential(KEY));
    let result = [{primaryLanguage: {iso6391Name: 'en'}}];
    if(pr_body){
      try{
        let startTime = Date.now();
        result = await TAclient.analyze("LanguageDetection", [pr_body]);
        let duration = Date.now() - startTime;
        appIClient.trackDependency({target:"API:Language Detection", name:"get pull request language", duration:duration, resultCode:0, success: true, dependencyTypeName: "HTTP"});
        if(!['en', 'es', 'pt', 'fr'].includes(result[0].primaryLanguage.iso6391Name)){
          result[0].primaryLanguage.iso6391Name = 'en';
        }
      }catch(err){
        app.log.error(err);
        appIClient.trackException({exception: err});
      }
    }
    
    // read file that aligns with detected language 
    const issue_body = fs.readFileSync('./issue_template/copilot-usage-'+result[0].primaryLanguage.iso6391Name+'.md', 'utf-8');

    // find XXX in file and replace with pr_number
    let fileContent = dedent(issue_body.replace(/XXX/g, '#'+pr_number.toString()) );
    
    // display the body for the issue
    app.log.info(fileContent);

    // create an issue using fileContent as body
    try{
      await context.octokit.issues.create({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        title: "Copilot Usage - PR#" + pr_number.toString(),
        body: fileContent,
        assignee: context.payload.pull_request.user.login
      });
    }catch(err){
      app.log.error(err);
      appIClient.trackException({exception: err});
    }
  });

  app.on("issues.edited", async (context) => {
    if(context.payload.issue.title.startsWith("Copilot Usage - PR#")){
      appIClient.trackEvent({name: "Issue Edited Payload", properties: context.payload});
      await GetSurveyData(context);
    }
  });

  app.on("issue_comment.created", async (context) => {
    if(context.payload.issue.title.startsWith("Copilot Usage - PR#")){
      appIClient.trackEvent({name: "Issue Comment Created Payload", properties: context.payload});
      comment = context.payload.comment.body;
      await GetSurveyData(context);
      comment = null;
    }
  });

  async function GetSurveyData(context){
    let issue_body = context.payload.issue.body;
    let issue_id = context.payload.issue.id;

    // find regex [0-9]\+ in issue_body and get first result
    let pr_number = issue_body.match(/[0-9]+/)[0];

    // find regex \[x\] in issue_body and get complete line in an array
    let checkboxes = issue_body.match(/\[x\].*/g);

    // find if checkboxes array contains Sim o Si or Yes
    let isCopilotUsed = checkboxes.some((checkbox) => {
      return checkbox.includes("Sim") || checkbox.includes("Si") || checkbox.includes("Yes") || checkbox.includes("Oui");
    });

    if(comment){
      let startTime = Date.now();
      await insertIntoDB(context, issue_id, pr_number, isCopilotUsed, null);
      let duration = Date.now() - startTime;
      appIClient.trackDependency({target:"DB:copilotUsage", name:"insert when comment is present", duration:duration, resultCode:0, success: true, dependencyTypeName: "SQL"});
    }

    if(isCopilotUsed){
      let startTime = Date.now();
      await insertIntoDB(context, issue_id, pr_number, isCopilotUsed, null);
      let duration = Date.now() - startTime;
      appIClient.trackDependency({target:"DB:copilotUsage", name:"insert when Yes is selected", duration:duration, resultCode:0, success: true, dependencyTypeName: "SQL"});

      // loop through checkboxes and find the one that contains %
      let pctSelected = false;
      let pctValue = new Array();
      for (const checkbox of checkboxes) {
        if(checkbox.includes("%")){
          pctSelected = true;
          copilotPercentage = checkbox;
          copilotPercentage = copilotPercentage.replace(/\[x\] /g, '');
          pctValue.push(copilotPercentage);
          app.log.info(copilotPercentage);
        }
      }
      if(pctSelected){
        // save into sql atabase with connstring

        let startTime = Date.now();
        await insertIntoDB(context, issue_id, pr_number, isCopilotUsed, pctValue);
        let duration = Date.now() - startTime;
        appIClient.trackDependency({target:"DB:copilotUsage", name:"insert when pct is selected", duration:duration, resultCode:0, success: true, dependencyTypeName: "SQL"});

        // close the issue
        try{
          await context.octokit.issues.update({
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            issue_number: context.payload.issue.number,
            state: "closed"
          });
        }
        catch(err){
          app.log.error(err);
          appIClient.trackException({exception: err});
        }
      }
    }else{
      if (checkboxes.some((checkbox) => {
        return checkbox.includes("Não") || checkbox.includes("No") || checkbox.includes("Non"); })){

        let startTime = Date.now();
        await insertIntoDB(context, issue_id, pr_number, isCopilotUsed, null);
        let duration = Date.now() - startTime;
        appIClient.trackDependency({target:"DB:copilotUsage", name:"insert when No is selected", duration:duration, resultCode:0, success: true, dependencyTypeName: "SQL"});

        if(comment){
          try{
            // close the issue
            await context.octokit.issues.update({
              owner: context.payload.repository.owner.login,
              repo: context.payload.repository.name,
              issue_number: context.payload.issue.number,
              state: "closed"
            });
          }catch(err){
            app.log.error(err);
            appIClient.trackException({exception: err});
          }
        }
      }
    }
  }

  async function insertIntoDB(context, issue_id, pr_number, isCopilotUsed, pctValue){
    let conn = null;
    try{
      conn = await sql.connect(ConnString);

      let result = await sql.query`SELECT * FROM SurveyResults WHERE issue_id = ${issue_id}`;

      // convert pctValue to string
      if(pctValue){
        pctValue = pctValue.toString();
      }

      if(result.recordset.length > 0){
        // update existing record
        let update_result = await sql.query`UPDATE SurveyResults SET PR_number = ${pr_number}, Value_detected = ${isCopilotUsed}, Value_percentage = ${pctValue}, Value_ndetected_reason = ${comment}, 	completed_at = ${context.payload.issue.updated_at} WHERE issue_id = ${issue_id}`;
        app.log.info(update_result);
      }else {
        // check if enterprise is present in context.payload
        let enterprise_name = null;
        let assignee_name = null;
        if(context.payload.enterprise){
          enterprise_name = context.payload.enterprise.name;
        }
        if(context.payload.issue.assignee){
          assignee_name = context.payload.issue.assignee.login;
        }
        
        let insert_result = await sql.query`INSERT INTO SurveyResults VALUES(${enterprise_name}, ${context.payload.repository.owner.login}, ${context.payload.repository.name}, ${context.payload.issue.id}, ${context.payload.issue.number}, ${pr_number}, ${assignee_name}, ${isCopilotUsed}, ${pctValue}, ${comment}, ${context.payload.issue.created_at}, ${context.payload.issue.updated_at})`;
        app.log.info(insert_result);
      }
    }catch(err){
      app.log.error(err);
      appIClient.trackException({exception: err});
    }finally{
      if(conn){
        conn.close();
      }
    }
  }

  appIClient.flush();

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};
